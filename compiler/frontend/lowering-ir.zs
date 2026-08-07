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
  ModuleConstantDeclaration,
  ParameterMode,
  Program,
  ReceiverMode,
  Statement,
  StatementArena,
  StatementKind,
  TypeReference,
  expressionKindName,
  statementKindName,
} from "./parser.zs";
import {
  ParsedModule,
  moduleSymbolIndex,
} from "./module-symbols.zs";
import {
  ModuleGraph,
  ModuleSemanticEvidence,
  ModuleSymbolKind,
} from "./semantic-model.zs";
import { genericTypeShape } from "./semantic-type-shapes.zs";

export enum LoweredTypeKind {
  voidType,
  booleanType,
  i8Type,
  i16Type,
  i32Type,
  i64Type,
  u8Type,
  u16Type,
  u32Type,
  u64Type,
  isizeType,
  usizeType,
  f32Type,
  f64Type,
  fsLockType,
  stringType,
  cstringType,
  arrayType,
  mapType,
  setType,
  structType,
  classType,
  onceType,
  onceLifetimeType,
  mutexType,
  taskType,
  enumType,
  foreignEnumType,
}

export struct LoweredType {
  kind: LoweredTypeKind;
  name: String;
}

export struct LoweredField {
  name: String;
  type: LoweredType;
  optionalField: boolean;
}

export struct LoweredStruct {
  name: String;
  nativeCName: String;
  fields: Array<LoweredField>;
  referenceType: boolean;
  threadShareable: boolean;
  workerDestructible: boolean;
  needsDeinit: boolean;
  deinitializer: Option<LoweredFunction>;
}

export struct LoweredArray {
  name: String;
  elementType: LoweredType;
}

export struct LoweredMap {
  name: String;
  keyType: LoweredType;
  valueType: LoweredType;
}

export struct LoweredSet {
  name: String;
  elementType: LoweredType;
}

export struct LoweredEnum {
  name: String;
  nativeCName: String;
  nativeCUnderlyingType: String;
  variants: Array<LoweredVariant>;
  payloadBearing: boolean;
  needsDeinit: boolean;
}

export struct LoweredVariant {
  name: String;
  payload: Option<LoweredType>;
}

export enum LoweredParameterMode {
  value,
  input,
  output,
  inputOutput,
}

export struct LoweredParameter {
  name: String;
  type: LoweredType;
  mode: LoweredParameterMode;
}

export enum LoweredExpressionKind {
  localValue,
  foreignValue,
  parameterValue,
  receiverValue,
  integerValue,
  stringValue,
  booleanValue,
  checkedAddInteger,
  checkedSubtractInteger,
  checkedMultiplyInteger,
  checkedDivideInteger,
  checkedRemainderInteger,
  checkedShiftLeftInteger,
  checkedShiftRightInteger,
  checkedNegateInteger,
  integerConversion,
  wrappingAddInteger,
  wrappingSubtractInteger,
  wrappingMultiplyInteger,
  fsLockUnlock,
  moveValue,
  copyValue,
  viewProjection,
  borrowedTemporary,
  unaryOperation,
  binaryOperation,
  conditionalValue,
  optionalFieldValue,
  optionalCallValue,
  directCall,
  methodCall,
  fieldValue,
  structValue,
  classValue,
  mutexValue,
  mutexWithLock,
  onceEmpty,
  onceInitialize,
  onceGet,
  threadSpawn,
  threadAwait,
  threadCancel,
  threadMainCall,
  enumValue,
  enumPayloadValue,
  stringEqual,
  stringLength,
  stringIsEmpty,
  stringByteAt,
  stringCopyBytes,
  templateValue,
  arrayEmpty,
  arrayLength,
  arrayIndex,
  arrayMutableIndex,
  arrayPush,
  mapEmpty,
  mapLength,
  mapHas,
  mapGet,
  mapSet,
  setEmpty,
  setLength,
  setHas,
  setAdd,
  textBufferEmpty,
  textBufferAppend,
  textBufferAppendBytes,
  textBufferAppendAscii,
}

export struct LoweredExpression {
  kind: LoweredExpressionKind;
  value: String;
  children: Array<usize>;
  statements: Array<usize>;
  labels: Array<String>;
  captureBindingOffsets: Array<usize> = Array<usize>();
}

export struct LoweredMainDelaySegment {
  roots: Array<usize>;
  milliseconds: String;
}

export enum LoweredStatementKind {
  localStatement,
  assignmentStatement,
  returnStatement,
  expressionStatement,
  blockStatement,
  ifStatement,
  whileStatement,
  forStatement,
  tryStatement,
  matchStatement,
  matchArmStatement,
  breakStatement,
  continueStatement,
  testExpectationStatement,
}

export struct LoweredStatement {
  kind: LoweredStatementKind;
  mutableBinding: boolean;
  name: String;
  type: Option<LoweredType>;
  expression: Option<usize>;
  secondExpression: Option<usize>;
  children: Array<usize>;
  cleanups: Array<LoweredCleanup>;
  liveFlag: String;
  labels: Array<String>;
  matchConsumesSubject: boolean;
  matchBindingNeedsCleanup: boolean;
}

export struct LoweredCleanup {
  name: String;
  type: LoweredType;
  guard: String;
}

export struct LoweredLiveFlag {
  owner: String;
  name: String;
  parameter: boolean;
}

struct LoweredClosureCapture {
  name: String;
  type: LoweredType;
  owned: boolean;
}

export struct LoweredFunction {
  name: String;
  testName: String;
  sourcePath: String;
  nativeCExportName: String;
  asynchronous: boolean;
  mainDelaySegments: Array<LoweredMainDelaySegment>;
  receiverType: Option<LoweredType>;
  receiverMode: LoweredParameterMode;
  parameters: Array<LoweredParameter>;
  returnType: LoweredType;
  fallthroughExpression: Option<usize>;
  expressions: Array<LoweredExpression>;
  statements: Array<LoweredStatement>;
  roots: Array<usize>;
  fallthroughCleanups: Array<LoweredCleanup>;
  liveFlags: Array<LoweredLiveFlag>;
}

export struct LoweredForeignFunction {
  header: String;
  nativeName: String;
  wrapperName: String;
  resultType: String;
  errorType: LoweredType;
  parameterTypes: Array<LoweredType>;
  successValues: Array<String>;
}

export struct LoweredConstant {
  name: String;
  type: LoweredType;
  initializerKind: LoweredExpressionKind;
  value: String;
}

export struct LoweredProgram {
  foreignHeaders: Array<String>;
  foreignFunctions: Array<LoweredForeignFunction>;
  constants: Array<LoweredConstant>;
  arrays: Array<LoweredArray>;
  maps: Array<LoweredMap>;
  sets: Array<LoweredSet>;
  structs: Array<LoweredStruct>;
  enums: Array<LoweredEnum>;
  functions: Array<LoweredFunction>;
}

struct LoweredImportedType {
  localName: String;
  targetName: String;
  kind: LoweredTypeKind;
  threadShareable: boolean;
  workerDestructible: boolean;
  needsDeinit: boolean;
  fields: Array<LoweredField>;
  variants: Array<LoweredVariant>;
  payloadBearing: boolean;
  underlyingType: String;
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

function classIndex(in program: Program, in name: String): Option<usize> {
  let index: usize = 0;
  while (index < program.aggregates.length) {
    if (
      program.aggregates[index].kind == DeclarationKind.classDeclaration
      && program.aggregates[index].name == name
    ) return Option.some(index);
    index = index + 1;
  }
  return Option<usize>.none;
}

function enumIndex(in program: Program, in name: String): Option<usize> {
  let index: usize = 0;
  while (index < program.enums.length) {
    if (program.enums[index].name == name) return Option.some(index);
    index = index + 1;
  }
  return Option<usize>.none;
}

function enumHasPayload(in program: Program, index: usize): boolean {
  for (const variant of program.enums[index].variants) {
    match (in variant.payload) {
      some(_) => return true;
      none => {}
    }
  }
  return false;
}

function stringStartsWith(in value: String, in prefix: String): boolean {
  if (value.byteLength < prefix.byteLength) return false;
  let index: usize = 0;
  while (index < prefix.byteLength) {
    if (value.byteAt(index) != prefix.byteAt(index)) return false;
    index = index + 1;
  }
  return true;
}

function loweredTypeIdentity(in type: LoweredType): String {
  if (type.kind == LoweredTypeKind.voidType) return "void";
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
  if (type.kind == LoweredTypeKind.fsLockType) return "FsLock";
  if (type.kind == LoweredTypeKind.stringType) return "String";
  if (type.kind == LoweredTypeKind.cstringType) return "cstring";
  if (type.kind == LoweredTypeKind.mutexType) {
    return type.name.copyBytes(0, type.name.byteLength);
  }
  return type.name.copyBytes(0, type.name.byteLength);
}

function intrinsicOptionName(in payload: LoweredType): String {
  const identity = loweredTypeIdentity(payload);
  return `__z_Option_${identity}`;
}

function intrinsicArrayName(in elementType: LoweredType): String {
  const identity = loweredTypeIdentity(elementType);
  return `__z_Array_${identity}`;
}

function intrinsicMapName(
  in keyType: LoweredType,
  in valueType: LoweredType
): String {
  const keyIdentity = loweredTypeIdentity(keyType);
  const valueIdentity = loweredTypeIdentity(valueType);
  return `__z_Map_${keyIdentity.byteLength}_${keyIdentity}${valueIdentity}`;
}

function intrinsicSetName(in elementType: LoweredType): String {
  const identity = loweredTypeIdentity(elementType);
  return `__z_Set_${identity}`;
}

function intrinsicOnceName(in valueType: LoweredType): String {
  const identity = loweredTypeIdentity(valueType);
  return `Once_${identity}`;
}

function intrinsicOnceLifetimeName(in valueType: LoweredType): String {
  const identity = loweredTypeIdentity(valueType);
  return `OnceLifetime_${identity}`;
}

function intrinsicMutexName(in valueType: LoweredType): String {
  const identity = loweredTypeIdentity(valueType);
  return `Mutex_${identity}`;
}

function intrinsicTaskName(in resultType: LoweredType): String {
  const identity = loweredTypeIdentity(resultType);
  return `Task_${identity}`;
}

function taskStorageType(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in taskTypeName: String
): LoweredType throws String {
  const generic = match (genericTypeShape(taskTypeName)) {
    some(shape) => shape;
    none => throw "native task lowering requires Task<T> or Task<T, E>";
  };
  if (
    generic.base != "Task"
    || (generic.arguments.length != 1 && generic.arguments.length != 2)
  ) throw "native task lowering requires Task<T> or Task<T, E>";
  const successType = try lowerModuleTypeName(
    program,
    importedTypes,
    generic.arguments[0]
  );
  if (generic.arguments.length == 1) return successType;
  const errorType = try lowerModuleTypeName(
    program,
    importedTypes,
    generic.arguments[1]
  );
  return LoweredType({
    kind: LoweredTypeKind.enumType,
    name: intrinsicResultName(successType, errorType),
  });
}

function intrinsicResultName(
  in successType: LoweredType,
  in errorType: LoweredType
): String {
  const successIdentity = loweredTypeIdentity(successType);
  const errorIdentity = loweredTypeIdentity(errorType);
  return `__z_Result_${successIdentity}_${errorIdentity}`;
}

function intrinsicOptionPayloadName(in name: String): Option<String> {
  const prefix = "__z_Option_";
  if (!stringStartsWith(name, prefix)) return Option<String>.none;
  return Option.some(name.copyBytes(prefix.byteLength, name.byteLength));
}

function sourceTypeIsOption(in name: String): boolean {
  match (genericTypeShape(name)) {
    some(generic) => return generic.base == "Option"
      && generic.arguments.length == 1;
    none => return stringStartsWith(name, "__z_Option_");
  }
}

function stableOptionalChainSource(
  in tree: ExpressionTree,
  index: usize
): boolean {
  if (
    tree.nodes[index].kind == ExpressionKind.identifierExpression
    || tree.nodes[index].kind == ExpressionKind.argumentBindingExpression
    || tree.nodes[index].kind == ExpressionKind.argumentReferenceExpression
  ) return true;
  if (
    tree.nodes[index].kind != ExpressionKind.memberExpression
    || tree.nodes[index].optionalAccess
    || tree.nodes[index].children.length != 1
  ) return false;
  const receiver = tree.nodes[index].children[0];
  return stableOptionalChainSource(tree, receiver);
}

function lowerTypeName(
  in program: Program,
  in name: String
): LoweredType throws String {
  if (name == "void") return LoweredType({ kind: LoweredTypeKind.voidType, name: "" });
  if (name == "boolean") {
    return LoweredType({ kind: LoweredTypeKind.booleanType, name: "" });
  }
  if (name == "i8") return LoweredType({ kind: LoweredTypeKind.i8Type, name: "" });
  if (name == "i16") return LoweredType({ kind: LoweredTypeKind.i16Type, name: "" });
  if (name == "i32") return LoweredType({ kind: LoweredTypeKind.i32Type, name: "" });
  if (name == "i64") return LoweredType({ kind: LoweredTypeKind.i64Type, name: "" });
  if (name == "u8") return LoweredType({ kind: LoweredTypeKind.u8Type, name: "" });
  if (name == "u16") return LoweredType({ kind: LoweredTypeKind.u16Type, name: "" });
  if (name == "u32") return LoweredType({ kind: LoweredTypeKind.u32Type, name: "" });
  if (name == "u64") return LoweredType({ kind: LoweredTypeKind.u64Type, name: "" });
  if (name == "isize") {
    return LoweredType({ kind: LoweredTypeKind.isizeType, name: "" });
  }
  if (name == "usize") {
    return LoweredType({ kind: LoweredTypeKind.usizeType, name: "" });
  }
  if (name == "f32") return LoweredType({ kind: LoweredTypeKind.f32Type, name: "" });
  if (name == "f64") return LoweredType({ kind: LoweredTypeKind.f64Type, name: "" });
  if (name == "__z_std_fs_Lock" || name == "fs.Lock") {
    return LoweredType({
      kind: LoweredTypeKind.fsLockType,
      name: "FsLock",
    });
  }
  if (name == "String" || name == "TextBuffer") {
    return LoweredType({
      kind: LoweredTypeKind.stringType,
      name: "String",
    });
  }
  if (name == "cstring") {
    return LoweredType({
      kind: LoweredTypeKind.cstringType,
      name: "cstring",
    });
  }
  if (stringStartsWith(name, "__z_Array_")) {
    return LoweredType({
      kind: LoweredTypeKind.arrayType,
      name: name.copyBytes(0, name.byteLength),
    });
  }
  if (stringStartsWith(name, "__z_Map_")) {
    return LoweredType({
      kind: LoweredTypeKind.mapType,
      name: name.copyBytes(0, name.byteLength),
    });
  }
  if (stringStartsWith(name, "__z_Set_")) {
    return LoweredType({
      kind: LoweredTypeKind.setType,
      name: name.copyBytes(0, name.byteLength),
    });
  }
  if (stringStartsWith(name, "view ")) {
    const targetName = name.copyBytes(5, name.byteLength);
    return try lowerTypeName(program, targetName);
  }
  match (intrinsicOptionPayloadName(name)) {
    some(_) => return LoweredType({
      kind: LoweredTypeKind.enumType,
      name: name.copyBytes(0, name.byteLength),
    });
    none => {}
  }
  match (genericTypeShape(name)) {
    some(generic) => {
      if (generic.base == "Option" && generic.arguments.length == 1) {
        const payload = try lowerTypeName(program, generic.arguments[0]);
        return LoweredType({
          kind: LoweredTypeKind.enumType,
          name: intrinsicOptionName(payload),
        });
      }
      if (generic.base == "Array" && generic.arguments.length == 1) {
        const elementType = try lowerTypeName(program, generic.arguments[0]);
        return LoweredType({
          kind: LoweredTypeKind.arrayType,
          name: intrinsicArrayName(elementType),
        });
      }
      if (generic.base == "Map" && generic.arguments.length == 2) {
        const keyType = try lowerTypeName(program, generic.arguments[0]);
        const valueType = try lowerTypeName(program, generic.arguments[1]);
        return LoweredType({
          kind: LoweredTypeKind.mapType,
          name: intrinsicMapName(keyType, valueType),
        });
      }
      if (generic.base == "Set" && generic.arguments.length == 1) {
        const elementType = try lowerTypeName(program, generic.arguments[0]);
        return LoweredType({
          kind: LoweredTypeKind.setType,
          name: intrinsicSetName(elementType),
        });
      }
      if (generic.base == "Once" && generic.arguments.length == 1) {
        const valueType = try lowerTypeName(program, generic.arguments[0]);
        return LoweredType({
          kind: LoweredTypeKind.onceType,
          name: intrinsicOnceName(valueType),
        });
      }
      if (
        generic.base == "OnceLifetime"
        && generic.arguments.length == 1
      ) {
        const valueType = try lowerTypeName(program, generic.arguments[0]);
        return LoweredType({
          kind: LoweredTypeKind.onceLifetimeType,
          name: intrinsicOnceLifetimeName(valueType),
        });
      }
      if (generic.base == "Mutex" && generic.arguments.length == 1) {
        const valueType = try lowerTypeName(program, generic.arguments[0]);
        return LoweredType({
          kind: LoweredTypeKind.mutexType,
          name: intrinsicMutexName(valueType),
        });
      }
      if (
        generic.base == "Task"
        && (generic.arguments.length == 1 || generic.arguments.length == 2)
      ) {
        const successType = try lowerTypeName(program, generic.arguments[0]);
        let resultType = LoweredType({
          kind: successType.kind,
          name: successType.name.copyBytes(0, successType.name.byteLength),
        });
        if (generic.arguments.length == 2) {
          const errorType = try lowerTypeName(program, generic.arguments[1]);
          resultType = LoweredType({
            kind: LoweredTypeKind.enumType,
            name: intrinsicResultName(successType, errorType),
          });
        }
        return LoweredType({
          kind: LoweredTypeKind.taskType,
          name: intrinsicTaskName(resultType),
        });
      }
      if (generic.base == "Result" && generic.arguments.length == 2) {
        const successType = try lowerTypeName(program, generic.arguments[0]);
        const errorType = try lowerTypeName(program, generic.arguments[1]);
        return LoweredType({
          kind: LoweredTypeKind.enumType,
          name: intrinsicResultName(successType, errorType),
        });
      }
    }
    none => {}
  }
  match (structIndex(program, name)) {
    some(_) => return LoweredType({
      kind: LoweredTypeKind.structType,
      name: name.copyBytes(0, name.byteLength),
    });
    none => {}
  }
  match (classIndex(program, name)) {
    some(_) => return LoweredType({
      kind: LoweredTypeKind.classType,
      name: name.copyBytes(0, name.byteLength),
    });
    none => {}
  }
  match (enumIndex(program, name)) {
    some(_) => return LoweredType({
      kind: LoweredTypeKind.enumType,
      name: name.copyBytes(0, name.byteLength),
    });
    none => {}
  }
  throw `native local lowering could not resolve type ${name}`;
}

function lowerType(in program: Program, in type: TypeReference): LoweredType throws String {
  return try lowerTypeName(program, type.name);
}

function lowerModuleTypeName(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in name: String
): LoweredType throws String {
  if (stringStartsWith(name, "view ")) {
    const targetName = name.copyBytes(5, name.byteLength);
    return try lowerModuleTypeName(
      program,
      importedTypes,
      targetName
    );
  }
  match (genericTypeShape(name)) {
    some(generic) => {
      if (generic.base == "Option" && generic.arguments.length == 1) {
        const payload = try lowerModuleTypeName(
          program,
          importedTypes,
          generic.arguments[0]
        );
        return LoweredType({
          kind: LoweredTypeKind.enumType,
          name: intrinsicOptionName(payload),
        });
      }
      if (generic.base == "Array" && generic.arguments.length == 1) {
        const elementType = try lowerModuleTypeName(
          program,
          importedTypes,
          generic.arguments[0]
        );
        return LoweredType({
          kind: LoweredTypeKind.arrayType,
          name: intrinsicArrayName(elementType),
        });
      }
      if (generic.base == "Map" && generic.arguments.length == 2) {
        const keyType = try lowerModuleTypeName(
          program,
          importedTypes,
          generic.arguments[0]
        );
        const valueType = try lowerModuleTypeName(
          program,
          importedTypes,
          generic.arguments[1]
        );
        return LoweredType({
          kind: LoweredTypeKind.mapType,
          name: intrinsicMapName(keyType, valueType),
        });
      }
      if (generic.base == "Set" && generic.arguments.length == 1) {
        const elementType = try lowerModuleTypeName(
          program,
          importedTypes,
          generic.arguments[0]
        );
        return LoweredType({
          kind: LoweredTypeKind.setType,
          name: intrinsicSetName(elementType),
        });
      }
      if (generic.base == "Once" && generic.arguments.length == 1) {
        const valueType = try lowerModuleTypeName(
          program,
          importedTypes,
          generic.arguments[0]
        );
        return LoweredType({
          kind: LoweredTypeKind.onceType,
          name: intrinsicOnceName(valueType),
        });
      }
      if (
        generic.base == "OnceLifetime"
        && generic.arguments.length == 1
      ) {
        const valueType = try lowerModuleTypeName(
          program,
          importedTypes,
          generic.arguments[0]
        );
        return LoweredType({
          kind: LoweredTypeKind.onceLifetimeType,
          name: intrinsicOnceLifetimeName(valueType),
        });
      }
      if (generic.base == "Mutex" && generic.arguments.length == 1) {
        const valueType = try lowerModuleTypeName(
          program,
          importedTypes,
          generic.arguments[0]
        );
        return LoweredType({
          kind: LoweredTypeKind.mutexType,
          name: intrinsicMutexName(valueType),
        });
      }
      if (
        generic.base == "Task"
        && (generic.arguments.length == 1 || generic.arguments.length == 2)
      ) {
        const successType = try lowerModuleTypeName(
          program,
          importedTypes,
          generic.arguments[0]
        );
        let resultType = LoweredType({
          kind: successType.kind,
          name: successType.name.copyBytes(0, successType.name.byteLength),
        });
        if (generic.arguments.length == 2) {
          const errorType = try lowerModuleTypeName(
            program,
            importedTypes,
            generic.arguments[1]
          );
          resultType = LoweredType({
            kind: LoweredTypeKind.enumType,
            name: intrinsicResultName(successType, errorType),
          });
        }
        return LoweredType({
          kind: LoweredTypeKind.taskType,
          name: intrinsicTaskName(resultType),
        });
      }
      if (generic.base == "Result" && generic.arguments.length == 2) {
        const successType = try lowerModuleTypeName(
          program,
          importedTypes,
          generic.arguments[0]
        );
        const errorType = try lowerModuleTypeName(
          program,
          importedTypes,
          generic.arguments[1]
        );
        return LoweredType({
          kind: LoweredTypeKind.enumType,
          name: intrinsicResultName(successType, errorType),
        });
      }
    }
    none => {}
  }
  let importedIndex = importedTypes.length;
  while (importedIndex > 0) {
    importedIndex = importedIndex - 1;
    if (
      importedTypes[importedIndex].localName == name
      || importedTypes[importedIndex].targetName == name
    ) return LoweredType({
      kind: importedTypes[importedIndex].kind,
      name: importedTypes[importedIndex].targetName.copyBytes(
        0,
        importedTypes[importedIndex].targetName.byteLength
      ),
    });
  }
  const local = attempt lowerTypeName(program, name);
  match (local) {
    success(type) => return type;
    failure(_) => {}
  }
  throw `native module lowering could not resolve type ${name} against ${program.aggregates.length} local aggregate(s), ${program.enums.length} local enum(s), and ${importedTypes.length} imported type(s)`;
}

function lowerModuleType(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in type: TypeReference
): LoweredType throws String {
  return try lowerModuleTypeName(program, importedTypes, type.name);
}

function lowerBindingType(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in arena: StatementArena,
  in ownerName: String,
  index: usize
): LoweredType throws String {
  match (in arena.nodes[index].typeAnnotation) {
    some(annotation) => return try lowerModuleType(
      program,
      importedTypes,
      annotation
    );
    none => {}
  }
  for (const binding of evidence.bindingResolutions) {
    if (
      binding.offset == arena.nodes[index].nameOffset
      && binding.name == arena.nodes[index].name
    ) return try lowerModuleTypeName(
      program,
      importedTypes,
      binding.typeName
    );
  }
  match (in arena.nodes[index].expression) {
    some(expression) => match (in expression.tree) {
      some(tree) => {
        const root = tree.root;
        match (staticallyResolvedExpressionTypeName(
          program,
          importedTypes,
          evidence,
          arena,
          ownerName,
          tree,
          root
        )) {
          some(typeName) => return try lowerModuleTypeName(
            program,
            importedTypes,
            typeName
          );
          none => {}
        }
      }
      none => {}
    }
    none => {}
  }
  throw `native lowering could not find the inferred type for local ${arena.nodes[index].name}`;
}

function enumNeedsCleanup(
  in program: Program,
  index: usize,
  depth: usize
): boolean {
  if (depth > program.aggregates.length + program.enums.length) return false;
  for (const variant of program.enums[index].variants) {
    match (in variant.payload) {
      some(payload) => {
        const loweredPayload = attempt lowerType(program, payload);
        match (loweredPayload) {
          success(type) => {
            if (
              type.kind == LoweredTypeKind.arrayType
              || type.kind == LoweredTypeKind.stringType
              || type.kind == LoweredTypeKind.fsLockType
            ) return true;
          }
          failure(_) => {}
        }
        match (structIndex(program, payload.name)) {
          some(aggregateIndex) => {
            if (aggregateNeedsCleanup(program, aggregateIndex, depth + 1)) {
              return true;
            }
          }
          none => {}
        }
        match (enumIndex(program, payload.name)) {
          some(enumPosition) => {
            if (enumNeedsCleanup(program, enumPosition, depth + 1)) return true;
          }
          none => {}
        }
      }
      none => {}
    }
  }
  return false;
}

function aggregateNeedsCleanup(
  in program: Program,
  index: usize,
  depth: usize
): boolean {
  if (
    program.aggregates[index].kind == DeclarationKind.classDeclaration
  ) return true;
  if (depth > program.aggregates.length + program.enums.length) return false;
  match (in program.aggregates[index].deinitializer) {
    some(_) => return true;
    none => {}
  }
  for (const field of program.aggregates[index].fields) {
    const loweredField = attempt lowerType(program, field.type);
    match (loweredField) {
      success(type) => {
        if (
          type.kind == LoweredTypeKind.arrayType
          || type.kind == LoweredTypeKind.stringType
          || type.kind == LoweredTypeKind.fsLockType
        ) return true;
      }
      failure(_) => {}
    }
    match (structIndex(program, field.type.name)) {
      some(fieldIndex) => {
        if (aggregateNeedsCleanup(program, fieldIndex, depth + 1)) return true;
      }
      none => {}
    }
    match (enumIndex(program, field.type.name)) {
      some(fieldIndex) => {
        if (enumNeedsCleanup(program, fieldIndex, depth + 1)) return true;
      }
      none => {}
    }
  }
  return false;
}

function typeNeedsCleanup(in program: Program, in type: LoweredType): boolean {
  if (
    type.kind == LoweredTypeKind.arrayType
    || type.kind == LoweredTypeKind.mapType
    || type.kind == LoweredTypeKind.setType
    || type.kind == LoweredTypeKind.stringType
    || type.kind == LoweredTypeKind.fsLockType
    || type.kind == LoweredTypeKind.classType
    || type.kind == LoweredTypeKind.onceLifetimeType
    || type.kind == LoweredTypeKind.mutexType
    || type.kind == LoweredTypeKind.taskType
  ) return true;
  if (type.kind == LoweredTypeKind.structType) {
    match (structIndex(program, type.name)) {
      some(index) => return aggregateNeedsCleanup(program, index, 0);
      none => return false;
    }
  }
  if (type.kind == LoweredTypeKind.enumType) {
    match (enumIndex(program, type.name)) {
      some(index) => return enumNeedsCleanup(program, index, 0);
      none => {}
    }
    match (intrinsicOptionPayloadName(type.name)) {
      some(payloadName) => {
        const payload = attempt lowerTypeName(program, payloadName);
        return match (payload) {
          success(lowered) => typeNeedsCleanup(program, lowered);
          failure(_) => false;
        };
      }
      none => {}
    }
    for (const declaration of program.functions) {
      match (in declaration.errorType) {
        some(error) => {
          const successType = attempt lowerType(program, declaration.returnType);
          const errorType = attempt lowerType(program, error);
          match (successType) {
            success(successValue) => {
              match (errorType) {
                success(errorValue) => {
                  if (
                    intrinsicResultName(successValue, errorValue) == type.name
                  ) {
                    return typeNeedsCleanup(program, successValue)
                      || typeNeedsCleanup(program, errorValue);
                  }
                }
                failure(_) => {}
              }
            }
            failure(_) => {}
          }
        }
        none => {}
      }
    }
  }
  return false;
}

function moduleEnumNeedsCleanup(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  index: usize,
  depth: usize
): boolean {
  if (depth > program.aggregates.length + program.enums.length) return false;
  for (const variant of program.enums[index].variants) {
    match (in variant.payload) {
      some(payload) => {
        match (structIndex(program, payload.name)) {
          some(aggregateIndex) => {
            if (moduleAggregateNeedsCleanup(
              program,
              importedTypes,
              aggregateIndex,
              depth + 1
            )) return true;
            continue;
          }
          none => {}
        }
        match (enumIndex(program, payload.name)) {
          some(enumDeclarationIndex) => {
            if (moduleEnumNeedsCleanup(
              program,
              importedTypes,
              enumDeclarationIndex,
              depth + 1
            )) return true;
            continue;
          }
          none => {}
        }
        const lowered = attempt lowerModuleType(program, importedTypes, payload);
        match (lowered) {
          success(type) => {
            if (moduleTypeNeedsCleanupDepth(
              program,
              importedTypes,
              type,
              depth + 1
            )) return true;
          }
          failure(_) => {}
        }
      }
      none => {}
    }
  }
  return false;
}

function moduleAggregateNeedsCleanup(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  index: usize,
  depth: usize
): boolean {
  if (
    program.aggregates[index].kind == DeclarationKind.classDeclaration
  ) return true;
  if (depth > program.aggregates.length + program.enums.length) return false;
  match (in program.aggregates[index].deinitializer) {
    some(_) => return true;
    none => {}
  }
  for (const field of program.aggregates[index].fields) {
    match (structIndex(program, field.type.name)) {
      some(aggregateIndex) => {
        if (moduleAggregateNeedsCleanup(
          program,
          importedTypes,
          aggregateIndex,
          depth + 1
        )) return true;
        continue;
      }
      none => {}
    }
    match (enumIndex(program, field.type.name)) {
      some(enumDeclarationIndex) => {
        if (moduleEnumNeedsCleanup(
          program,
          importedTypes,
          enumDeclarationIndex,
          depth + 1
        )) return true;
        continue;
      }
      none => {}
    }
    const lowered = attempt lowerModuleType(program, importedTypes, field.type);
    match (lowered) {
      success(type) => {
        if (moduleTypeNeedsCleanupDepth(
          program,
          importedTypes,
          type,
          depth + 1
        )) return true;
      }
      failure(_) => {}
    }
  }
  return false;
}

function moduleTypeNeedsCleanupDepth(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in type: LoweredType,
  depth: usize
): boolean {
  if (
    type.kind == LoweredTypeKind.arrayType
    || type.kind == LoweredTypeKind.mapType
    || type.kind == LoweredTypeKind.setType
    || type.kind == LoweredTypeKind.stringType
    || type.kind == LoweredTypeKind.fsLockType
    || type.kind == LoweredTypeKind.classType
    || type.kind == LoweredTypeKind.onceLifetimeType
    || type.kind == LoweredTypeKind.mutexType
    || type.kind == LoweredTypeKind.taskType
  ) return true;
  if (type.kind == LoweredTypeKind.structType) {
    match (structIndex(program, type.name)) {
      some(index) => return moduleAggregateNeedsCleanup(
        program,
        importedTypes,
        index,
        depth
      );
      none => {}
    }
  }
  if (type.kind == LoweredTypeKind.enumType) {
    match (enumIndex(program, type.name)) {
      some(index) => return moduleEnumNeedsCleanup(
        program,
        importedTypes,
        index,
        depth
      );
      none => {}
    }
  }
  let importedIndex = importedTypes.length;
  while (importedIndex > 0) {
    importedIndex = importedIndex - 1;
    if (
      importedTypes[importedIndex].kind == type.kind
      && (
        importedTypes[importedIndex].localName == type.name
        || importedTypes[importedIndex].targetName == type.name
      )
    ) return importedTypes[importedIndex].needsDeinit;
  }
  return typeNeedsCleanup(program, type);
}

function moduleTypeNeedsCleanup(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in type: LoweredType
): boolean {
  return moduleTypeNeedsCleanupDepth(program, importedTypes, type, 0);
}

function threadShareablePrimitive(in name: String): boolean {
  return name == "void"
    || name == "boolean"
    || name == "i8"
    || name == "i16"
    || name == "i32"
    || name == "i64"
    || name == "u8"
    || name == "u16"
    || name == "u32"
    || name == "u64"
    || name == "isize"
    || name == "usize"
    || name == "f32"
    || name == "f64"
    || name == "String";
}

function copyTypePath(in values: Array<String>): Array<String> {
  let output = Array<String>();
  for (const value of values) {
    output.push(value.copyBytes(0, value.byteLength));
  }
  return output;
}

function moduleTypeIsWorkerDestructible(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in name: String,
  in visiting: Array<String>
): boolean {
  if (threadShareablePrimitive(name)) return true;
  match (genericTypeShape(name)) {
    some(generic) => {
      if (
        (
          generic.base == "Option"
          || generic.base == "Mutex"
        )
        && generic.arguments.length == 1
      ) return moduleTypeIsWorkerDestructible(
        program,
        importedTypes,
        generic.arguments[0],
        visiting
      );
      if (generic.base == "Result" && generic.arguments.length == 2) {
        for (const argument of generic.arguments) {
          if (!moduleTypeIsWorkerDestructible(
            program,
            importedTypes,
            argument,
            visiting
          )) return false;
        }
        return true;
      }
      return false;
    }
    none => {}
  }
  if (containsString(visiting, name)) return true;
  for (const declaration of program.aggregates) {
    if (declaration.name != name) continue;
    if (declaration.kind == DeclarationKind.classDeclaration) {
      return moduleTypeIsThreadShareable(
        program,
        importedTypes,
        name,
        visiting
      );
    }
    if (declaration.executorAffinity.byteLength > 0) return false;
    match (in declaration.deinitializer) {
      some(_) => return false;
      none => {}
    }
    let nextVisiting = copyTypePath(visiting);
    nextVisiting.push(name.copyBytes(0, name.byteLength));
    for (const field of declaration.fields) {
      if (
        field.executorAffinity.byteLength > 0
        || !moduleTypeIsWorkerDestructible(
          program,
          importedTypes,
          field.type.name,
          nextVisiting
        )
      ) return false;
    }
    return true;
  }
  for (const declaration of program.enums) {
    if (declaration.name != name) continue;
    let nextVisiting = copyTypePath(visiting);
    nextVisiting.push(name.copyBytes(0, name.byteLength));
    for (const variant of declaration.variants) {
      match (in variant.payload) {
        some(payload) => {
          if (!moduleTypeIsWorkerDestructible(
            program,
            importedTypes,
            payload.name,
            nextVisiting
          )) return false;
        }
        none => {}
      }
    }
    return true;
  }
  let importedIndex = importedTypes.length;
  while (importedIndex > 0) {
    importedIndex = importedIndex - 1;
    if (
      importedTypes[importedIndex].localName == name
      || importedTypes[importedIndex].targetName == name
    ) return importedTypes[importedIndex].workerDestructible;
  }
  return false;
}

function moduleTypeIsThreadShareable(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in name: String,
  in visiting: Array<String>
): boolean {
  if (threadShareablePrimitive(name)) return true;
  match (genericTypeShape(name)) {
    some(generic) => {
      if (
        (generic.base == "Option" && generic.arguments.length == 1)
        || (generic.base == "Result" && generic.arguments.length == 2)
      ) {
        for (const argument of generic.arguments) {
          if (!moduleTypeIsThreadShareable(
            program,
            importedTypes,
            argument,
            visiting
          )) return false;
        }
        return true;
      }
      if (generic.base == "Mutex" && generic.arguments.length == 1) {
        return moduleTypeIsWorkerDestructible(
          program,
          importedTypes,
          generic.arguments[0],
          visiting
        );
      }
      return false;
    }
    none => {}
  }
  if (containsString(visiting, name)) return true;
  for (const declaration of program.aggregates) {
    if (declaration.name != name) continue;
    if (declaration.executorAffinity.byteLength > 0) return false;
    match (in declaration.deinitializer) {
      some(_) => return false;
      none => {}
    }
    for (const method of declaration.methods) {
      if (method.receiverMode == ReceiverMode.inputOutput) return false;
    }
    let nextVisiting = copyTypePath(visiting);
    nextVisiting.push(name.copyBytes(0, name.byteLength));
    for (const field of declaration.fields) {
      if (
        !field.readonlyField
        || field.executorAffinity.byteLength > 0
        || !moduleTypeIsThreadShareable(
          program,
          importedTypes,
          field.type.name,
          nextVisiting
        )
      ) return false;
    }
    return true;
  }
  for (const declaration of program.enums) {
    if (declaration.name != name) continue;
    let nextVisiting = copyTypePath(visiting);
    nextVisiting.push(name.copyBytes(0, name.byteLength));
    for (const variant of declaration.variants) {
      match (in variant.payload) {
        some(payload) => {
          if (!moduleTypeIsThreadShareable(
            program,
            importedTypes,
            payload.name,
            nextVisiting
          )) return false;
        }
        none => {}
      }
    }
    return true;
  }
  let importedIndex = importedTypes.length;
  while (importedIndex > 0) {
    importedIndex = importedIndex - 1;
    if (
      importedTypes[importedIndex].localName == name
      || importedTypes[importedIndex].targetName == name
    ) return importedTypes[importedIndex].threadShareable;
  }
  return false;
}

function intrinsicArrayDeclaration(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in name: String
): Option<LoweredArray> throws String {
  match (genericTypeShape(name)) {
    some(generic) => {
      if (generic.base != "Array" || generic.arguments.length != 1) {
        return Option<LoweredArray>.none;
      }
      const elementType = try lowerModuleTypeName(
        program,
        importedTypes,
        generic.arguments[0]
      );
      return Option.some(LoweredArray({
        name: intrinsicArrayName(elementType),
        elementType,
      }));
    }
    none => return Option<LoweredArray>.none;
  }
}

function intrinsicMapDeclaration(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in name: String
): Option<LoweredMap> throws String {
  match (genericTypeShape(name)) {
    some(generic) => {
      if (generic.base != "Map" || generic.arguments.length != 2) {
        return Option<LoweredMap>.none;
      }
      const keyType = try lowerModuleTypeName(
        program,
        importedTypes,
        generic.arguments[0]
      );
      const valueType = try lowerModuleTypeName(
        program,
        importedTypes,
        generic.arguments[1]
      );
      return Option.some(LoweredMap({
        name: intrinsicMapName(keyType, valueType),
        keyType,
        valueType,
      }));
    }
    none => return Option<LoweredMap>.none;
  }
}

function intrinsicSetDeclaration(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in name: String
): Option<LoweredSet> throws String {
  match (genericTypeShape(name)) {
    some(generic) => {
      if (generic.base != "Set" || generic.arguments.length != 1) {
        return Option<LoweredSet>.none;
      }
      const elementType = try lowerModuleTypeName(
        program,
        importedTypes,
        generic.arguments[0]
      );
      return Option.some(LoweredSet({
        name: intrinsicSetName(elementType),
        elementType,
      }));
    }
    none => return Option<LoweredSet>.none;
  }
}

function intrinsicOptionDeclaration(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in name: String
): Option<LoweredEnum> throws String {
  match (intrinsicOptionPayloadName(name)) {
    some(payloadName) => {
      const payload = try lowerModuleTypeName(
        program,
        importedTypes,
        payloadName
      );
      let variants = Array<LoweredVariant>();
      variants.push(LoweredVariant({
        name: "some",
        payload: Option.some(LoweredType({
          kind: payload.kind,
          name: payload.name.copyBytes(0, payload.name.byteLength),
        })),
      }));
      variants.push(LoweredVariant({
        name: "none",
        payload: Option<LoweredType>.none,
      }));
      return Option.some(LoweredEnum({
        name: intrinsicOptionName(payload),
        nativeCName: "",
        nativeCUnderlyingType: "",
        variants,
        payloadBearing: true,
        needsDeinit: moduleTypeNeedsCleanup(
          program,
          importedTypes,
          payload
        ),
      }));
    }
    none => {}
  }
  match (genericTypeShape(name)) {
    some(generic) => {
      if (generic.base != "Option" || generic.arguments.length != 1) {
        return Option<LoweredEnum>.none;
      }
      const payload = try lowerModuleTypeName(
        program,
        importedTypes,
        generic.arguments[0]
      );
      let variants = Array<LoweredVariant>();
      variants.push(LoweredVariant({
        name: "some",
        payload: Option.some(LoweredType({
          kind: payload.kind,
          name: payload.name.copyBytes(0, payload.name.byteLength),
        })),
      }));
      variants.push(LoweredVariant({
        name: "none",
        payload: Option<LoweredType>.none,
      }));
      return Option.some(LoweredEnum({
        name: intrinsicOptionName(payload),
        nativeCName: "",
        nativeCUnderlyingType: "",
        variants,
        payloadBearing: true,
        needsDeinit: moduleTypeNeedsCleanup(program, importedTypes, payload),
      }));
    }
    none => return Option<LoweredEnum>.none;
  }
}

function intrinsicResultDeclaration(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in name: String
): Option<LoweredEnum> throws String {
  match (genericTypeShape(name)) {
    some(generic) => {
      if (generic.base != "Result" || generic.arguments.length != 2) {
        return Option<LoweredEnum>.none;
      }
      const successType = try lowerModuleTypeName(
        program,
        importedTypes,
        generic.arguments[0]
      );
      const errorType = try lowerModuleTypeName(
        program,
        importedTypes,
        generic.arguments[1]
      );
      let variants = Array<LoweredVariant>();
      let successPayload = Option<LoweredType>.none;
      if (successType.kind != LoweredTypeKind.voidType) {
        successPayload = Option.some(LoweredType({
          kind: successType.kind,
          name: successType.name.copyBytes(0, successType.name.byteLength),
        }));
      }
      variants.push(LoweredVariant({
        name: "success",
        payload: successPayload,
      }));
      variants.push(LoweredVariant({
        name: "failure",
        payload: Option.some(LoweredType({
          kind: errorType.kind,
          name: errorType.name.copyBytes(0, errorType.name.byteLength),
        })),
      }));
      return Option.some(LoweredEnum({
        name: intrinsicResultName(successType, errorType),
        nativeCName: "",
        nativeCUnderlyingType: "",
        variants,
        payloadBearing: true,
        needsDeinit: moduleTypeNeedsCleanup(
          program,
          importedTypes,
          successType
        ) || moduleTypeNeedsCleanup(program, importedTypes, errorType),
      }));
    }
    none => return Option<LoweredEnum>.none;
  }
}

function intrinsicEnumDeclaration(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in name: String
): Option<LoweredEnum> throws String {
  const option = try intrinsicOptionDeclaration(
    program,
    importedTypes,
    name
  );
  match (option) {
    some(declaration) => return Option.some(move declaration);
    none => {}
  }
  return try intrinsicResultDeclaration(program, importedTypes, name);
}

function throwingFunctionResult(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in ownerName: String
): Option<LoweredEnum> throws String {
  for (const declaration of program.functions) {
    if (declaration.name == ownerName) {
      match (in declaration.errorType) {
        some(errorType) => {
          const returnName = declaration.returnType.name.copyBytes(
            0,
            declaration.returnType.name.byteLength
          );
          const errorName = errorType.name.copyBytes(0, errorType.name.byteLength);
          const resultName = `Result<${returnName}, ${errorName}>`;
          return try intrinsicResultDeclaration(
            program,
            importedTypes,
            resultName
          );
        }
        none => return Option<LoweredEnum>.none;
      }
    }
  }
  return Option<LoweredEnum>.none;
}

function copyCleanup(in cleanup: LoweredCleanup): LoweredCleanup {
  return LoweredCleanup({
    name: cleanup.name.copyBytes(0, cleanup.name.byteLength),
    type: LoweredType({
      kind: cleanup.type.kind,
      name: cleanup.type.name.copyBytes(0, cleanup.type.name.byteLength),
    }),
    guard: cleanup.guard.copyBytes(0, cleanup.guard.byteLength),
  });
}

function treeMovesName(
  in program: Program,
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize,
  in name: String
): boolean {
  if (
    tree.nodes[index].kind == ExpressionKind.matchExpression
    && tree.nodes[index].value != "in"
    && tree.nodes[index].children.length > 0
  ) {
    const subject = tree.nodes[index].children[0];
    if (
      tree.nodes[subject].kind == ExpressionKind.identifierExpression
      && tree.nodes[subject].value == name
    ) return true;
  }
  if (
    tree.nodes[index].kind == ExpressionKind.unaryExpression
    && tree.nodes[index].value == "move"
    && tree.nodes[index].children.length == 1
  ) {
    const operand = tree.nodes[index].children[0];
    if (
      tree.nodes[operand].kind == ExpressionKind.identifierExpression
      && tree.nodes[operand].value == name
    ) return true;
  }
  if (
    tree.nodes[index].kind == ExpressionKind.callExpression
    && tree.nodes[index].children.length > 0
  ) {
    const parameterModes = resolvedCallParameterModes(
      program,
      evidence,
      tree,
      index
    );
    let argumentPosition: usize = 1;
    while (
      argumentPosition < tree.nodes[index].children.length
      && argumentPosition - 1 < parameterModes.length
    ) {
      const argument = tree.nodes[index].children[argumentPosition];
      if (
        parameterModes[argumentPosition - 1] == "value"
        && tree.nodes[argument].kind == ExpressionKind.identifierExpression
        && tree.nodes[argument].value == name
      ) return true;
      argumentPosition = argumentPosition + 1;
    }
    const callee = tree.nodes[index].children[0];
    if (
      tree.nodes[callee].kind == ExpressionKind.memberExpression
      && tree.nodes[callee].children.length == 1
      && tree.nodes[index].children.length == 2
    ) {
      const enumInput = tree.nodes[callee].children[0];
      const payload = tree.nodes[index].children[1];
      if (
        tree.nodes[enumInput].kind == ExpressionKind.identifierExpression
        && tree.nodes[payload].kind == ExpressionKind.identifierExpression
        && tree.nodes[payload].value == name
      ) {
        if (
          tree.nodes[enumInput].value == "Option"
          || tree.nodes[enumInput].value == "Result"
        ) return true;
        for (const declaration of program.enums) {
          if (declaration.name != tree.nodes[enumInput].value) continue;
          for (const variant of declaration.variants) {
            if (variant.name == tree.nodes[callee].value) return true;
          }
        }
      }
    }
    if (
      tree.nodes[callee].kind == ExpressionKind.memberExpression
      && tree.nodes[callee].children.length == 1
    ) {
      const receiver = tree.nodes[callee].children[0];
      let consumesReceiver = tree.nodes[callee].value == "finish";
      if (tree.nodes[callee].value == "unlock") {
        match (resolvedExpressionTypeName(evidence, tree, receiver)) {
          some(typeName) => {
            consumesReceiver = typeName == "fs.Lock"
              || typeName == "__z_std_fs_Lock";
          }
          none => {}
        }
      }
      if (
        consumesReceiver
        &&
        tree.nodes[receiver].kind == ExpressionKind.identifierExpression
        && tree.nodes[receiver].value == name
      ) return true;
    }
    if (
      tree.nodes[callee].kind == ExpressionKind.memberExpression
      && tree.nodes[callee].value == "push"
      && tree.nodes[index].children.length == 2
    ) {
      const argument = tree.nodes[index].children[1];
      if (
        tree.nodes[argument].kind == ExpressionKind.identifierExpression
        && tree.nodes[argument].value == name
      ) return true;
    }
    if (tree.nodes[callee].kind == ExpressionKind.identifierExpression) {
      if (tree.nodes[index].children.length == 2) {
        const initializer = tree.nodes[index].children[1];
        if (tree.nodes[initializer].kind == ExpressionKind.objectExpression) {
          for (const field of tree.nodes[initializer].children) {
            if (
              tree.nodes[field].kind == ExpressionKind.identifierExpression
              && tree.nodes[field].value == name
            ) return true;
          }
        }
      }
      for (const declaration of program.functions) {
        if (declaration.name != tree.nodes[callee].value) continue;
        let parameter: usize = 0;
        while (
          parameter < declaration.parameters.length
          && parameter + 1 < tree.nodes[index].children.length
        ) {
          const argument = tree.nodes[index].children[parameter + 1];
          if (
            declaration.parameters[parameter].mode == ParameterMode.value
            && tree.nodes[argument].kind == ExpressionKind.identifierExpression
            && tree.nodes[argument].value == name
          ) return true;
          parameter = parameter + 1;
        }
      }
    }
  }
  for (const child of tree.nodes[index].children) {
    if (treeMovesName(program, evidence, tree, child, name)) return true;
  }
  return false;
}

function syntaxMovesName(
  in program: Program,
  in evidence: ModuleSemanticEvidence,
  in expression: ExpressionSyntax,
  in name: String
): boolean {
  return match (in expression.tree) {
    some(tree) => {
      const root = tree.root;
      select treeMovesName(program, evidence, tree, root, name);
    }
    none => false;
  };
}

function syntaxIsIdentifier(
  in expression: ExpressionSyntax,
  in name: String
): boolean {
  return match (in expression.tree) {
    some(tree) => tree.nodes[tree.root].kind
      == ExpressionKind.identifierExpression
      && tree.nodes[tree.root].value == name;
    none => false;
  };
}

function arenaMovesName(
  in program: Program,
  in evidence: ModuleSemanticEvidence,
  in arena: StatementArena,
  in name: String
): boolean {
  for (const statement of arena.nodes) {
    if (statementMovesName(program, evidence, arena, statement, name)) {
      return true;
    }
  }
  return false;
}

function loweredThreadSpawnMovesBinding(
  in expressions: Array<LoweredExpression>,
  in name: String,
  bindingOffset: usize
): boolean {
  for (const expression of expressions) {
    if (
      expression.kind != LoweredExpressionKind.threadSpawn
      || expression.labels.length < 5
      || (expression.labels.length - 5) % 2 != 0
    ) continue;
    let captureChild: usize = 0;
    if (expression.labels[0] == "expression") captureChild = 1;
    let captureLabel: usize = 5;
    let captureIndex: usize = 0;
    while (captureLabel + 1 < expression.labels.length) {
      if (
        expression.labels[captureLabel] == name
        && captureIndex < expression.captureBindingOffsets.length
        && expression.captureBindingOffsets[captureIndex] == bindingOffset
        && captureChild < expression.children.length
      ) {
        const value = expression.children[captureChild];
        if (
          expressions[value].kind == LoweredExpressionKind.moveValue
          && expressions[value].children.length == 1
        ) return true;
      }
      captureLabel = captureLabel + 2;
      captureChild = captureChild + 1;
      captureIndex = captureIndex + 1;
    }
  }
  return false;
}

function statementMovesName(
  in program: Program,
  in evidence: ModuleSemanticEvidence,
  in arena: StatementArena,
  in statement: Statement,
  in name: String
): boolean {
  match (in statement.expression) {
    some(expression) => {
      if (
        (
          statement.kind == StatementKind.returnStatement
          || statement.kind == StatementKind.throwStatement
          || statement.kind == StatementKind.selectStatement
          || statement.kind == StatementKind.yieldStatement
        )
        && syntaxIsIdentifier(expression, name)
      ) return true;
      if (syntaxMovesName(program, evidence, expression, name)) return true;
    }
    none => {}
  }
  match (in statement.secondExpression) {
    some(expression) => {
      if (
        statement.kind == StatementKind.assignmentStatement
        && syntaxIsIdentifier(expression, name)
      ) return true;
      if (syntaxMovesName(program, evidence, expression, name)) return true;
    }
    none => {}
  }
  for (const child of statement.children) {
    if (statementMovesName(
      program,
      evidence,
      arena,
      arena.nodes[child],
      name
    )) {
      return true;
    }
  }
  return false;
}

function arenaHasControlFlow(in arena: StatementArena): boolean {
  for (const statement of arena.nodes) {
    if (
      statement.kind == StatementKind.ifStatement
      || statement.kind == StatementKind.whileStatement
    ) return true;
  }
  return false;
}

function ownerLiveFlag(in name: String): String {
  return `_z_stage1_live_${name}`;
}

function statementFallsThrough(in arena: StatementArena, index: usize): boolean {
  if (
    arena.nodes[index].kind == StatementKind.returnStatement
    || arena.nodes[index].kind == StatementKind.throwStatement
    || arena.nodes[index].kind == StatementKind.breakStatement
    || arena.nodes[index].kind == StatementKind.continueStatement
  ) return false;
  if (arena.nodes[index].kind == StatementKind.blockStatement) {
    let children = Array<usize>();
    for (const child of arena.nodes[index].children) {
      children.push(child);
    }
    return sequenceFallsThrough(arena, children);
  }
  if (arena.nodes[index].kind == StatementKind.ifStatement) {
    if (arena.nodes[index].children.length < 2) return true;
    const thenBranch = arena.nodes[index].children[0];
    const elseBranch = arena.nodes[index].children[1];
    return statementFallsThrough(arena, thenBranch)
      || statementFallsThrough(arena, elseBranch);
  }
  return true;
}

function sequenceFallsThrough(
  in arena: StatementArena,
  in roots: Array<usize>
): boolean {
  for (const root of roots) {
    if (!statementFallsThrough(arena, root)) return false;
  }
  return true;
}

function loweredSequenceFallsThrough(
  in statements: Array<LoweredStatement>,
  in roots: Array<usize>
): boolean {
  if (roots.length == 0) return true;
  const last = roots[roots.length - 1];
  if (
    statements[last].kind == LoweredStatementKind.returnStatement
    || statements[last].kind == LoweredStatementKind.breakStatement
    || statements[last].kind == LoweredStatementKind.continueStatement
  ) return false;
  if (statements[last].kind == LoweredStatementKind.blockStatement) {
    return loweredSequenceFallsThrough(statements, statements[last].children);
  }
  return true;
}

function appendCleanupCopies(
  inout output: Array<LoweredCleanup>,
  in cleanups: Array<LoweredCleanup>
): void {
  for (const cleanup of cleanups) {
    output.push(copyCleanup(cleanup));
  }
}

function appendStatementCleanupCopies(
  inout statements: Array<LoweredStatement>,
  index: usize,
  in cleanups: Array<LoweredCleanup>
): void {
  for (const cleanup of cleanups) {
    statements[index].cleanups.push(copyCleanup(cleanup));
  }
}

function attachReplacementCleanup(
  in arena: StatementArena,
  index: usize,
  in cleanups: Array<LoweredCleanup>,
  inout statements: Array<LoweredStatement>,
  loweredIndex: usize
): void {
  match (in arena.nodes[index].expression) {
    some(expression) => match (in expression.tree) {
      some(tree) => {
        if (tree.nodes[tree.root].kind != ExpressionKind.identifierExpression) {
          return;
        }
        for (const cleanup of cleanups) {
          if (tree.nodes[tree.root].value == cleanup.name) {
            statements[loweredIndex].cleanups.push(copyCleanup(cleanup));
            return;
          }
        }
      }
      none => {}
    }
    none => {}
  }
}

function loweredStatementHasLabel(
  in statement: LoweredStatement,
  in label: String
): boolean {
  for (const candidate of statement.labels) {
    if (candidate == label) return true;
  }
  return false;
}

function planNestedPreludeSequence(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in roots: Array<usize>,
  in inherited: Array<LoweredCleanup>,
  inout statements: Array<LoweredStatement>
): Array<LoweredCleanup> throws String {
  let active = Array<LoweredCleanup>();
  appendCleanupCopies(inout active, inherited);
  let finalCleanups = Array<LoweredCleanup>();
  let rootPosition: usize = 0;
  while (rootPosition + 1 < roots.length) {
    const local = roots[rootPosition];
    if (statements[local].kind != LoweredStatementKind.localStatement) {
      throw "native cleanup planning received a non-local nested prelude";
    }
    if (loweredStatementHasLabel(statements[local], "nested-try")) {
      if (
        statements[local].children.length != 1
        || statements[statements[local].children[0]].kind
          != LoweredStatementKind.tryStatement
      ) throw "native cleanup planning received a malformed nested try prelude";
      const loweredTry = statements[local].children[0];
      appendStatementCleanupCopies(
        inout statements,
        loweredTry,
        active
      );
    } else if (
      loweredStatementHasLabel(statements[local], "nested-conditional")
    ) {
      if (
        statements[local].children.length != 1
        || statements[statements[local].children[0]].kind
          != LoweredStatementKind.ifStatement
      ) throw "native cleanup planning received a malformed nested conditional prelude";
      const loweredIf = statements[local].children[0];
      if (statements[loweredIf].children.length != 2) {
        throw "native cleanup planning received a conditional without two branches";
      }
      let conditionalBranches = Array<usize>();
      for (const branch of statements[loweredIf].children) {
        conditionalBranches.push(branch);
      }
      for (const branch of conditionalBranches) {
        if (statements[branch].kind != LoweredStatementKind.blockStatement) {
          throw "native cleanup planning received a malformed conditional branch";
        }
        let branchRoots = Array<usize>();
        for (const branchRoot of statements[branch].children) {
          branchRoots.push(branchRoot);
        }
        const branchCleanups = try planNestedPreludeSequence(
          program,
          importedTypes,
          branchRoots,
          active,
          inout statements
        );
        appendStatementCleanupCopies(
          inout statements,
          branch,
          branchCleanups
        );
      }
    } else {
      throw "native cleanup planning received an unknown nested prelude";
    }
    match (in statements[local].type) {
      some(type) => {
        const ownedType = LoweredType({
          kind: type.kind,
          name: type.name.copyBytes(0, type.name.byteLength),
        });
        if (moduleTypeNeedsCleanup(program, importedTypes, ownedType)) {
          const cleanup = LoweredCleanup({
            name: statements[local].name.copyBytes(
              0,
              statements[local].name.byteLength
            ),
            type: move ownedType,
            guard: "",
          });
          active.push(copyCleanup(cleanup));
          if (!loweredStatementHasLabel(statements[local], "transferred")) {
            finalCleanups.push(move cleanup);
          }
        }
      }
      none => throw "native cleanup planning lost a nested prelude type";
    }
    rootPosition = rootPosition + 1;
  }
  return finalCleanups;
}

function planCleanupStatement(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in arena: StatementArena,
  in ownerName: String,
  sourceIndex: usize,
  loweredIndex: usize,
  in live: Array<LoweredCleanup>,
  in expressions: Array<LoweredExpression>,
  inout statements: Array<LoweredStatement>,
  inout liveFlags: Array<LoweredLiveFlag>,
  insideLoop: boolean,
  in loopCleanups: Array<LoweredCleanup>
): void throws String {
  if (
    statements[loweredIndex].kind == LoweredStatementKind.blockStatement
    && statements[loweredIndex].labels.length == 1
    && statements[loweredIndex].labels[0] == "nested-try-normalized"
  ) {
    if (statements[loweredIndex].children.length < 2) {
      throw "native cleanup planning received an empty nested try block";
    }
    let preludeLive = Array<LoweredCleanup>();
    for (const cleanup of live) {
      if (
        arena.nodes[sourceIndex].kind == StatementKind.variableStatement
        && cleanup.name == arena.nodes[sourceIndex].name
      ) continue;
      preludeLive.push(copyCleanup(cleanup));
    }
    let normalizedRoots = Array<usize>();
    for (const child of statements[loweredIndex].children) {
      normalizedRoots.push(child);
    }
    const finalTemporaryCleanups = try planNestedPreludeSequence(
      program,
      importedTypes,
      normalizedRoots,
      preludeLive,
      inout statements
    );
    let finalLive = Array<LoweredCleanup>();
    appendCleanupCopies(inout finalLive, live);
    appendCleanupCopies(inout finalLive, finalTemporaryCleanups);
    const finalStatement = statements[loweredIndex].children[
      statements[loweredIndex].children.length - 1
    ];
    try planCleanupStatement(
      program,
      importedTypes,
      evidence,
      arena,
      ownerName,
      sourceIndex,
      finalStatement,
      finalLive,
      expressions,
      inout statements,
      inout liveFlags,
      insideLoop,
      loopCleanups
    );
    if (loweredSequenceFallsThrough(
      statements,
      statements[loweredIndex].children
    )) appendStatementCleanupCopies(
      inout statements,
      loweredIndex,
      finalTemporaryCleanups
    );
    return;
  }
  if (statements[loweredIndex].kind == LoweredStatementKind.returnStatement) {
    appendStatementCleanupCopies(inout statements, loweredIndex, live);
    return;
  }
  if (statements[loweredIndex].kind == LoweredStatementKind.tryStatement) {
    appendStatementCleanupCopies(inout statements, loweredIndex, live);
    return;
  }
  if (
    statements[loweredIndex].kind
      == LoweredStatementKind.testExpectationStatement
  ) {
    appendStatementCleanupCopies(inout statements, loweredIndex, live);
    return;
  }
  if (
    statements[loweredIndex].kind == LoweredStatementKind.localStatement
    && statements[loweredIndex].children.length == 1
    && statements[statements[loweredIndex].children[0]].kind
      == LoweredStatementKind.tryStatement
  ) {
    const loweredTry = statements[loweredIndex].children[0];
    for (const cleanup of live) {
      if (cleanup.name != statements[loweredIndex].name) {
        statements[loweredTry].cleanups.push(copyCleanup(cleanup));
      }
    }
    return;
  }
  if (
    statements[loweredIndex].kind == LoweredStatementKind.localStatement
    && statements[loweredIndex].children.length == 1
    && statements[statements[loweredIndex].children[0]].kind
      == LoweredStatementKind.matchStatement
  ) {
    const loweredMatch = statements[loweredIndex].children[0];
    let initializerLive = Array<LoweredCleanup>();
    for (const cleanup of live) {
      if (cleanup.name != statements[loweredIndex].name) {
        initializerLive.push(copyCleanup(cleanup));
      }
    }
    try planCleanupStatement(
      program,
      importedTypes,
      evidence,
      arena,
      ownerName,
      sourceIndex,
      loweredMatch,
      initializerLive,
      expressions,
      inout statements,
      inout liveFlags,
      insideLoop,
      loopCleanups
    );
    return;
  }
  if (statements[loweredIndex].kind == LoweredStatementKind.matchStatement) {
    match (in arena.nodes[sourceIndex].expression) {
      some(syntax) => {
        match (in syntax.tree) {
          some(tree) => {
            const root = tree.root;
            const consuming = tree.nodes[root].value != "in";
            const subject = tree.nodes[root].children[0];
            if (
              consuming
              && tree.nodes[subject].kind == ExpressionKind.identifierExpression
            ) {
              for (const cleanup of live) {
                if (cleanup.name == tree.nodes[subject].value) {
                  statements[loweredIndex].liveFlag = cleanup.guard.copyBytes(
                    0,
                    cleanup.guard.byteLength
                  );
                }
              }
            }
            let armPosition: usize = 1;
            while (armPosition < tree.nodes[root].children.length) {
              const arm = tree.nodes[root].children[armPosition];
              const loweredArm = statements[loweredIndex].children[armPosition - 1];
              let sourceRoots = Array<usize>();
              for (const bodyIndex of tree.nodes[arm].statements) {
                sourceRoots.push(bodyIndex);
              }
              let loweredRoots = Array<usize>();
              for (const bodyIndex of statements[loweredArm].children) {
                loweredRoots.push(bodyIndex);
              }
              let armLive = Array<LoweredCleanup>();
              appendCleanupCopies(inout armLive, live);
              let payloadCleanup = Option<LoweredCleanup>.none;
              if (statements[loweredArm].matchBindingNeedsCleanup) {
                const payloadType = match (in statements[loweredArm].type) {
                  some(type) => LoweredType({
                    kind: type.kind,
                    name: type.name.copyBytes(0, type.name.byteLength),
                  });
                  none => throw "native cleanup planning lost a match payload type";
                };
                if (statements[loweredArm].labels.length != 1) {
                  throw "native cleanup planning lost a match payload binding";
                }
                const cleanup = LoweredCleanup({
                  name: statements[loweredArm].labels[0].copyBytes(
                    0,
                    statements[loweredArm].labels[0].byteLength
                  ),
                  type: move payloadType,
                  guard: "",
                });
                armLive.push(copyCleanup(cleanup));
                payloadCleanup = Option.some(move cleanup);
              }
              const introduced = try planCleanupSequence(
                program,
                importedTypes,
                evidence,
                arena,
                ownerName,
                sourceRoots,
                loweredRoots,
                armLive,
                expressions,
                inout statements,
                inout liveFlags,
                insideLoop,
                loopCleanups
              );
              if (
                sequenceFallsThrough(arena, sourceRoots)
                && loweredSequenceFallsThrough(statements, loweredRoots)
              ) {
                match (in payloadCleanup) {
                  some(cleanup) => statements[loweredArm].cleanups.push(
                    copyCleanup(cleanup)
                  );
                  none => {}
                }
                appendStatementCleanupCopies(
                  inout statements,
                  loweredArm,
                  introduced
                );
              }
              armPosition = armPosition + 1;
            }
            return;
          }
          none => throw "native cleanup planning received an opaque match";
        }
      }
      none => throw "native cleanup planning received a match without an expression";
    }
  }
  if (arena.nodes[sourceIndex].kind == StatementKind.blockStatement) {
    let sourceChildren = Array<usize>();
    for (const child of arena.nodes[sourceIndex].children) {
      sourceChildren.push(child);
    }
    let loweredChildren = Array<usize>();
    for (const child of statements[loweredIndex].children) {
      loweredChildren.push(child);
    }
    const introduced = try planCleanupSequence(
      program,
      importedTypes,
      evidence,
      arena,
      ownerName,
      sourceChildren,
      loweredChildren,
      live,
      expressions,
      inout statements,
      inout liveFlags,
      insideLoop,
      loopCleanups
    );
    if (
      sequenceFallsThrough(arena, sourceChildren)
      && loweredSequenceFallsThrough(statements, loweredChildren)
    ) {
      appendStatementCleanupCopies(inout statements, loweredIndex, introduced);
    }
    return;
  }
  if (
    arena.nodes[sourceIndex].kind == StatementKind.breakStatement
    || arena.nodes[sourceIndex].kind == StatementKind.continueStatement
  ) {
    appendStatementCleanupCopies(inout statements, loweredIndex, loopCleanups);
    return;
  }
  if (
    arena.nodes[sourceIndex].kind == StatementKind.ifStatement
    || arena.nodes[sourceIndex].kind == StatementKind.whileStatement
    || arena.nodes[sourceIndex].kind == StatementKind.forStatement
  ) {
    let childIndex: usize = 0;
    while (childIndex < arena.nodes[sourceIndex].children.length) {
      const sourceChild = arena.nodes[sourceIndex].children[childIndex];
      const loweredChild = statements[loweredIndex].children[childIndex];
      let childLoopCleanups = Array<LoweredCleanup>();
      if (arena.nodes[sourceIndex].kind == StatementKind.ifStatement) {
        appendCleanupCopies(inout childLoopCleanups, loopCleanups);
      }
      try planCleanupStatement(
        program,
        importedTypes,
        evidence,
        arena,
        ownerName,
        sourceChild,
        loweredChild,
        live,
        expressions,
        inout statements,
        inout liveFlags,
        insideLoop
          || arena.nodes[sourceIndex].kind == StatementKind.whileStatement
          || arena.nodes[sourceIndex].kind == StatementKind.forStatement,
        childLoopCleanups
      );
      childIndex = childIndex + 1;
    }
  }
}

function planCleanupSequence(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in arena: StatementArena,
  in ownerName: String,
  in sourceRoots: Array<usize>,
  in loweredRoots: Array<usize>,
  in inherited: Array<LoweredCleanup>,
  in expressions: Array<LoweredExpression>,
  inout statements: Array<LoweredStatement>,
  inout liveFlags: Array<LoweredLiveFlag>,
  insideLoop: boolean,
  in inheritedLoopCleanups: Array<LoweredCleanup>
): Array<LoweredCleanup> throws String {
  let live = Array<LoweredCleanup>();
  appendCleanupCopies(inout live, inherited);
  let loopCleanups = Array<LoweredCleanup>();
  appendCleanupCopies(inout loopCleanups, inheritedLoopCleanups);
  let introduced = Array<LoweredCleanup>();
  let rootIndex: usize = 0;
  while (rootIndex < sourceRoots.length) {
    const sourceIndex = sourceRoots[rootIndex];
    const loweredIndex = loweredRoots[rootIndex];
    if (arena.nodes[sourceIndex].kind == StatementKind.variableStatement) {
      let localType = Option<LoweredType>.none;
      match (in statements[loweredIndex].type) {
        some(type) => localType = Option.some(LoweredType({
          kind: type.kind,
          name: type.name.copyBytes(0, type.name.byteLength),
        }));
        none => {}
      }
      match (localType) {
        some(type) => {
          const ownedType = LoweredType({
            kind: type.kind,
            name: type.name.copyBytes(0, type.name.byteLength),
          });
          let borrowedView = false;
          for (const binding of evidence.bindingResolutions) {
            if (
              binding.offset == arena.nodes[sourceIndex].nameOffset
              && binding.name == arena.nodes[sourceIndex].name
              && stringStartsWith(binding.typeName, "view ")
            ) borrowedView = true;
          }
          if (
            !borrowedView
            && moduleTypeNeedsCleanup(program, importedTypes, ownedType)
          ) {
            const bindingName = arena.nodes[sourceIndex].name.copyBytes(
              0,
              arena.nodes[sourceIndex].name.byteLength
            );
            const bindingOffset = arena.nodes[sourceIndex].nameOffset;
            const moved = arenaMovesName(
              program,
              evidence,
              arena,
              bindingName
            ) || loweredThreadSpawnMovesBinding(
              expressions,
              bindingName,
              bindingOffset
            );
            let guard = "";
            if (moved && arenaHasControlFlow(arena)) {
              guard = ownerLiveFlag(arena.nodes[sourceIndex].name);
              statements[loweredIndex].liveFlag = guard.copyBytes(
                0,
                guard.byteLength
              );
              liveFlags.push(LoweredLiveFlag({
                owner: arena.nodes[sourceIndex].name.copyBytes(
                  0,
                  arena.nodes[sourceIndex].name.byteLength
                ),
                name: guard.copyBytes(0, guard.byteLength),
                parameter: false,
              }));
            }
            if (!moved || guard.byteLength > 0) {
              const cleanup = LoweredCleanup({
                name: arena.nodes[sourceIndex].name.copyBytes(
                  0,
                  arena.nodes[sourceIndex].name.byteLength
                ),
                type: move ownedType,
                guard: move guard,
              });
              live.push(copyCleanup(cleanup));
              if (insideLoop) loopCleanups.push(copyCleanup(cleanup));
              introduced.push(move cleanup);
            }
          }
        }
        none => {}
      }
    } else if (
      arena.nodes[sourceIndex].kind == StatementKind.assignmentStatement
    ) {
      attachReplacementCleanup(
        arena,
        sourceIndex,
        live,
        inout statements,
        loweredIndex
      );
    }
    try planCleanupStatement(
      program,
      importedTypes,
      evidence,
      arena,
      ownerName,
      sourceIndex,
      loweredIndex,
      live,
      expressions,
      inout statements,
      inout liveFlags,
      insideLoop,
      loopCleanups
    );
    rootIndex = rootIndex + 1;
  }
  return introduced;
}

function expressionHasLabel(
  in expression: LoweredExpression,
  in label: String
): boolean {
  for (const candidate of expression.labels) {
    if (candidate == label) return true;
  }
  return false;
}

function attachMoveLiveFlagsRange(
  inout expressions: Array<LoweredExpression>,
  in liveFlags: Array<LoweredLiveFlag>,
  start: usize,
  end: usize
): void {
  let index = start;
  while (index < end) {
    if (
      expressions[index].kind == LoweredExpressionKind.moveValue
      && expressions[index].children.length == 1
      && !expressionHasLabel(expressions[index], "worker-owned-scope")
    ) {
      const operand = expressions[index].children[0];
      expressions[index].value = "";
      if (expressions[operand].kind == LoweredExpressionKind.localValue) {
        for (const flag of liveFlags) {
          if (flag.owner == expressions[operand].value) {
            expressions[index].value = flag.name.copyBytes(0, flag.name.byteLength);
          }
        }
      }
    }
    index = index + 1;
  }
}

function markWorkerOwnedMoveRange(
  inout expressions: Array<LoweredExpression>,
  start: usize,
  end: usize
): void {
  let index = start;
  while (index < end) {
    if (
      expressions[index].kind == LoweredExpressionKind.moveValue
      && !expressionHasLabel(expressions[index], "worker-owned-scope")
    ) expressions[index].labels.push("worker-owned-scope");
    index = index + 1;
  }
}

function attachMoveLiveFlags(
  inout expressions: Array<LoweredExpression>,
  in liveFlags: Array<LoweredLiveFlag>
): void {
  const end = expressions.length;
  attachMoveLiveFlagsRange(
    inout expressions,
    liveFlags,
    0,
    end
  );
}

function rewriteParameterValues(
  in parameters: Array<LoweredParameter>,
  inout expressions: Array<LoweredExpression>
): void {
  let expressionIndex: usize = 0;
  while (expressionIndex < expressions.length) {
    if (
      expressions[expressionIndex].kind == LoweredExpressionKind.localValue
    ) {
      for (const parameter of parameters) {
        if (
          parameter.mode != LoweredParameterMode.value
          && parameter.name == expressions[expressionIndex].value
        ) {
          expressions[expressionIndex].kind =
            LoweredExpressionKind.parameterValue;
        }
      }
    }
    expressionIndex = expressionIndex + 1;
  }
}

function markMutableStorage(
  inout expressions: Array<LoweredExpression>,
  index: usize
): void {
  let current = index;
  let traversing = true;
  while (traversing) {
    if (
      expressions[current].kind == LoweredExpressionKind.arrayIndex
    ) expressions[current].kind = LoweredExpressionKind.arrayMutableIndex;
    if (
      (
        expressions[current].kind == LoweredExpressionKind.fieldValue
        || expressions[current].kind
          == LoweredExpressionKind.arrayMutableIndex
      )
      && expressions[current].children.length > 0
    ) {
      current = expressions[current].children[0];
    } else {
      traversing = false;
    }
  }
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
    statements: Array<usize>(),
    labels,
  }));
  return index;
}

function wrapImplicitOwnedTransfer(
  in tree: ExpressionTree,
  input: usize,
  value: usize,
  inout output: Array<LoweredExpression>
): usize {
  if (
    tree.nodes[input].kind != ExpressionKind.identifierExpression
    || output[value].kind == LoweredExpressionKind.moveValue
  ) return value;
  let children = Array<usize>();
  children.push(value);
  return pushExpression(
    inout output,
    LoweredExpressionKind.moveValue,
    "",
    move children,
    Array<String>()
  );
}

function resolvedCallTarget(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): Option<String> {
  for (const resolution of evidence.callResolutions) {
    if (
      resolution.offset == tree.nodes[index].offset
      && resolution.line == tree.nodes[index].line
      && resolution.column == tree.nodes[index].column
    ) {
      if (
        resolution.kind == "foreign"
        && resolution.foreignSuccessValues.length > 0
      ) return Option.some(
        `z_stage1_foreign_${resolution.targetModuleIndex}_${resolution.targetSymbolIndex}`
      );
      return Option.some(resolution.targetName.copyBytes(
        0,
        resolution.targetName.byteLength
      ));
    }
  }
  return Option<String>.none;
}

function resolvedCallKind(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): String {
  for (const resolution of evidence.callResolutions) {
    if (
      resolution.offset == tree.nodes[index].offset
      && resolution.line == tree.nodes[index].line
      && resolution.column == tree.nodes[index].column
    ) return resolution.kind.copyBytes(0, resolution.kind.byteLength);
  }
  return "";
}

function resolvedCallIsAsynchronous(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): boolean {
  for (const resolution of evidence.callResolutions) {
    if (
      resolution.offset == tree.nodes[index].offset
      && resolution.line == tree.nodes[index].line
      && resolution.column == tree.nodes[index].column
    ) return resolution.asynchronous;
  }
  return false;
}

function resolvedCallReceiverMode(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): String {
  for (const resolution of evidence.callResolutions) {
    if (
      resolution.offset == tree.nodes[index].offset
      && resolution.line == tree.nodes[index].line
      && resolution.column == tree.nodes[index].column
    ) return resolution.receiverMode.copyBytes(
      0,
      resolution.receiverMode.byteLength
    );
  }
  return "";
}

function resolvedForeignCallTarget(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): Option<String> {
  for (const resolution of evidence.callResolutions) {
    if (
      resolution.offset == tree.nodes[index].offset
      && resolution.line == tree.nodes[index].line
      && resolution.column == tree.nodes[index].column
      && resolution.kind == "foreign"
    ) {
      if (resolution.foreignSuccessValues.length > 0) {
        return Option.some(
          `z_stage1_foreign_${resolution.targetModuleIndex}_${resolution.targetSymbolIndex}`
        );
      }
      return Option.some(resolution.targetName.copyBytes(
        0,
        resolution.targetName.byteLength
      ));
    }
  }
  return Option<String>.none;
}

function containsString(in values: Array<String>, in value: String): boolean {
  for (const candidate of values) {
    if (candidate == value) return true;
  }
  return false;
}

function containsForeignWrapper(
  in functions: Array<LoweredForeignFunction>,
  in name: String
): boolean {
  for (const candidate of functions) {
    if (candidate.wrapperName == name) return true;
  }
  return false;
}

function requireSafeForeignHeader(in header: String): void throws String {
  let index: usize = 0;
  while (index < header.byteLength) {
    const byte = header.byteAt(index);
    if (byte == 10 || byte == 13 || byte == 34) {
      throw "native foreign header contains a character unsafe for C inclusion";
    }
    index = index + 1;
  }
}

function collectForeignLowering(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  inout headers: Array<String>,
  inout functions: Array<LoweredForeignFunction>
): void throws String {
  for (const resolution of evidence.callResolutions) {
    if (resolution.kind != "foreign") continue;
    try requireSafeForeignHeader(resolution.foreignHeader);
    if (!containsString(headers, resolution.foreignHeader)) {
      headers.push(resolution.foreignHeader.copyBytes(
        0,
        resolution.foreignHeader.byteLength
      ));
    }
    if (resolution.foreignSuccessValues.length == 0) continue;
    const wrapperName =
      `z_stage1_foreign_${resolution.targetModuleIndex}_${resolution.targetSymbolIndex}`;
    if (containsForeignWrapper(functions, wrapperName)) continue;
    if (resolution.errorType.byteLength == 0) {
      throw "native foreign status lowering requires an error type";
    }
    let parameterTypes = Array<LoweredType>();
    for (const parameterType of resolution.parameterTypes) {
      const loweredParameter = try lowerModuleTypeName(
        program,
        importedTypes,
        parameterType
      );
      parameterTypes.push(loweredParameter);
    }
    const errorType = try lowerModuleTypeName(
      program,
      importedTypes,
      resolution.errorType
    );
    const resultName =
      `Result<${resolution.returnType}, ${resolution.errorType}>`;
    const resultType = try lowerModuleTypeName(
      program,
      importedTypes,
      resultName
    );
    let successValues = Array<String>();
    for (const successValue of resolution.foreignSuccessValues) {
      successValues.push(
        successValue.copyBytes(0, successValue.byteLength)
      );
    }
    functions.push(LoweredForeignFunction({
      header: resolution.foreignHeader.copyBytes(
        0,
        resolution.foreignHeader.byteLength
      ),
      nativeName: resolution.targetName.copyBytes(
        0,
        resolution.targetName.byteLength
      ),
      wrapperName,
      resultType: resultType.name.copyBytes(
        0,
        resultType.name.byteLength
      ),
      errorType,
      parameterTypes,
      successValues,
    }));
  }
}

function lowerParameterMode(mode: ParameterMode): LoweredParameterMode {
  if (mode == ParameterMode.input) return LoweredParameterMode.input;
  if (mode == ParameterMode.output) return LoweredParameterMode.output;
  if (mode == ParameterMode.inputOutput) {
    return LoweredParameterMode.inputOutput;
  }
  return LoweredParameterMode.value;
}

function lowerReceiverMode(mode: ReceiverMode): LoweredParameterMode {
  if (mode == ReceiverMode.inputOutput) {
    return LoweredParameterMode.inputOutput;
  }
  return LoweredParameterMode.input;
}

function parameterModeName(mode: ParameterMode): String {
  if (mode == ParameterMode.input) return "in";
  if (mode == ParameterMode.output) return "out";
  if (mode == ParameterMode.inputOutput) return "inout";
  return "value";
}

function resolvedCallParameterModes(
  in program: Program,
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): Array<String> {
  for (const resolution of evidence.callResolutions) {
    if (
      resolution.offset != tree.nodes[index].offset
      || resolution.line != tree.nodes[index].line
      || resolution.column != tree.nodes[index].column
    ) continue;
    let modes = Array<String>();
    for (const mode of resolution.parameterModes) {
      modes.push(mode.copyBytes(0, mode.byteLength));
    }
    return modes;
  }
  if (tree.nodes[index].children.length > 0) {
    const callee = tree.nodes[index].children[0];
    if (tree.nodes[callee].kind == ExpressionKind.identifierExpression) {
      for (const declaration of program.functions) {
        if (declaration.name != tree.nodes[callee].value) continue;
        let modes = Array<String>();
        for (const parameter of declaration.parameters) {
          modes.push(parameterModeName(parameter.mode));
        }
        return modes;
      }
    }
  }
  return Array<String>();
}

function resolvedCallParameterTypes(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): Array<String> {
  for (const resolution of evidence.callResolutions) {
    if (
      resolution.offset != tree.nodes[index].offset
      || resolution.line != tree.nodes[index].line
      || resolution.column != tree.nodes[index].column
    ) continue;
    let types = Array<String>();
    for (const type of resolution.parameterTypes) {
      types.push(type.copyBytes(0, type.byteLength));
    }
    return types;
  }
  return Array<String>();
}

function rewriteClosureParameterValues(
  inout expressions: Array<LoweredExpression>,
  start: usize,
  in parameterName: String
): void {
  let index = start;
  while (index < expressions.length) {
    if (
      expressions[index].kind == LoweredExpressionKind.localValue
      && expressions[index].value == parameterName
    ) expressions[index].kind = LoweredExpressionKind.parameterValue;
    index = index + 1;
  }
}

function loweredRangeMovesName(
  in expressions: Array<LoweredExpression>,
  start: usize,
  in name: String
): boolean {
  let index = start;
  while (index < expressions.length) {
    if (
      expressions[index].kind == LoweredExpressionKind.moveValue
      && expressions[index].children.length == 1
    ) {
      const operand = expressions[index].children[0];
      if (
        (
          expressions[operand].kind == LoweredExpressionKind.localValue
          || expressions[operand].kind == LoweredExpressionKind.parameterValue
        )
        && expressions[operand].value == name
      ) return true;
    }
    index = index + 1;
  }
  return false;
}

function attachThreadCaptureMoveFlags(
  inout expressions: Array<LoweredExpression>,
  start: usize,
  end: usize,
  in captures: Array<LoweredClosureCapture>
): void {
  let index = start;
  while (index < end) {
    if (
      expressions[index].kind != LoweredExpressionKind.moveValue
      || expressions[index].children.length != 1
    ) {
      index = index + 1;
      continue;
    }
    const operand = expressions[index].children[0];
    if (
      expressions[operand].kind != LoweredExpressionKind.localValue
      && expressions[operand].kind != LoweredExpressionKind.parameterValue
    ) {
      index = index + 1;
      continue;
    }
    let captureIndex: usize = 0;
    while (captureIndex < captures.length) {
      if (
        captures[captureIndex].owned
        && captures[captureIndex].name == expressions[operand].value
      ) {
        expressions[index].value = `(*_z_stage1_capture_live_${captureIndex})`;
      }
      captureIndex = captureIndex + 1;
    }
    index = index + 1;
  }
}

function validateOwnedThreadCaptures(
  in captures: Array<LoweredClosureCapture>,
  in captureMode: String,
  in expressions: Array<LoweredExpression>,
  bodyStart: usize
): void throws String {
  for (const capture of captures) {
    const sharedArc = capture.type.kind == LoweredTypeKind.classType;
    if (capture.owned && captureMode != "move") {
      throw `native thread.spawn requires a move closure to transfer ownership-bearing capture ${capture.name}`;
    }
    if (
      sharedArc
      && loweredRangeMovesName(expressions, bodyStart, capture.name)
    ) {
      throw `native thread.spawn cannot consume shared ARC capture ${capture.name}`;
    }
  }
}

function importedTypeThreadShareable(
  in importedTypes: Array<LoweredImportedType>,
  in type: LoweredType
): boolean {
  let index = importedTypes.length;
  while (index > 0) {
    index = index - 1;
    if (
      importedTypes[index].kind == type.kind
      && (
        importedTypes[index].localName == type.name
        || importedTypes[index].targetName == type.name
      )
    ) return importedTypes[index].threadShareable;
  }
  return false;
}

function pushThreadCaptureValue(
  inout expressions: Array<LoweredExpression>,
  in capture: LoweredClosureCapture
): usize {
  const local = pushExpression(
    inout expressions,
    LoweredExpressionKind.localValue,
    capture.name,
    Array<usize>(),
    Array<String>()
  );
  if (!capture.owned) return local;
  let children = Array<usize>();
  children.push(local);
  return pushExpression(
    inout expressions,
    LoweredExpressionKind.moveValue,
    "",
    children,
    Array<String>()
  );
}

function collectMutexClosureCaptures(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in ownerName: String,
  in expressions: Array<LoweredExpression>,
  start: usize,
  in parameterName: String,
  useOffset: usize
): Array<LoweredClosureCapture> throws String {
  let captures = Array<LoweredClosureCapture>();
  let index = start;
  while (index < expressions.length) {
    if (expressions[index].kind == LoweredExpressionKind.receiverValue) {
      throw "native Mutex.withLock closures cannot capture `this` yet";
    }
    if (
      expressions[index].kind != LoweredExpressionKind.localValue
      || expressions[index].value == parameterName
    ) {
      index = index + 1;
      continue;
    }
    const captureName = expressions[index].value.copyBytes(
      0,
      expressions[index].value.byteLength
    );
    let exists = false;
    for (const capture of captures) {
      if (capture.name == captureName) exists = true;
    }
    if (exists) {
      index = index + 1;
      continue;
    }
    const typeName = match (namedValueTypeName(
      program,
      evidence,
      ownerName,
      captureName,
      useOffset
    )) {
      some(name) => name;
      none => throw `native Mutex.withLock cannot resolve capture ${captureName}`;
    };
    const type = try lowerModuleTypeName(
      program,
      importedTypes,
      typeName
    );
    if (moduleTypeNeedsCleanup(program, importedTypes, type)) {
      throw `native Mutex.withLock does not support ownership-bearing capture ${captureName} yet`;
    }
    captures.push(LoweredClosureCapture({
      name: move captureName,
      type,
      owned: false,
    }));
    index = index + 1;
  }
  return captures;
}

function collectThreadClosureCaptures(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in ownerName: String,
  in expressions: Array<LoweredExpression>,
  start: usize,
  in statements: Array<LoweredStatement>,
  statementStart: usize,
  useOffset: usize
): Array<LoweredClosureCapture> throws String {
  let captures = Array<LoweredClosureCapture>();
  let index = start;
  while (index < expressions.length) {
    if (expressions[index].kind == LoweredExpressionKind.receiverValue) {
      throw "native thread.spawn closures cannot capture `this` yet";
    }
    if (expressions[index].kind != LoweredExpressionKind.localValue) {
      index = index + 1;
      continue;
    }
    let directCallee = false;
    let parentExpression = start;
    while (parentExpression < expressions.length) {
      if (
        expressions[parentExpression].kind
          == LoweredExpressionKind.directCall
        && expressions[parentExpression].children.length > 0
        && expressions[parentExpression].children[0] == index
      ) directCallee = true;
      parentExpression = parentExpression + 1;
    }
    if (directCallee) {
      index = index + 1;
      continue;
    }
    const captureName = expressions[index].value.copyBytes(
      0,
      expressions[index].value.byteLength
    );
    let declaredInside = false;
    let scanStatement = statementStart;
    while (scanStatement < statements.length) {
      if (
        statements[scanStatement].kind == LoweredStatementKind.localStatement
        && statements[scanStatement].name == captureName
      ) declaredInside = true;
      scanStatement = scanStatement + 1;
    }
    if (declaredInside) {
      index = index + 1;
      continue;
    }
    let exists = false;
    for (const capture of captures) {
      if (capture.name == captureName) exists = true;
    }
    if (exists) {
      index = index + 1;
      continue;
    }
    let resolvedType = Option<LoweredType>.none;
    let priorStatement: usize = 0;
    while (priorStatement < statementStart) {
      if (
        statements[priorStatement].kind == LoweredStatementKind.localStatement
        && statements[priorStatement].name == captureName
      ) {
        match (in statements[priorStatement].type) {
          some(type) => resolvedType = Option.some(LoweredType({
            kind: type.kind,
            name: type.name.copyBytes(0, type.name.byteLength),
          }));
          none => {}
        }
      }
      priorStatement = priorStatement + 1;
    }
    const type = match (resolvedType) {
      some(value) => value;
      none => {
        let typeName = "";
        if (expressions[index].labels.length > 0) {
          typeName = expressions[index].labels[0].copyBytes(
            0,
            expressions[index].labels[0].byteLength
          );
        } else {
          match (namedValueTypeName(
            program,
            evidence,
            ownerName,
            captureName,
            useOffset
          )) {
            some(name) => typeName = move name;
            none => throw `native thread.spawn cannot resolve capture ${captureName}`;
          }
        }
        select try lowerModuleTypeName(
          program,
          importedTypes,
          typeName
        );
      }
    };
    const needsCleanup = moduleTypeNeedsCleanup(
      program,
      importedTypes,
      type
    );
    const sharedArc = type.kind == LoweredTypeKind.classType
      && importedTypeThreadShareable(importedTypes, type);
    if (
      needsCleanup
      && type.kind == LoweredTypeKind.classType
      && !sharedArc
    ) {
      throw `native thread.spawn cannot retain non-shareable ARC capture ${captureName} of type ${type.name} yet`;
    }
    if (
      needsCleanup
      && type.kind != LoweredTypeKind.stringType
      && !sharedArc
    ) {
      throw `native thread.spawn does not support ownership-bearing capture ${captureName} yet`;
    }
    captures.push(LoweredClosureCapture({
      name: move captureName,
      type,
      owned: needsCleanup && !sharedArc,
    }));
    index = index + 1;
  }
  return captures;
}

function resolvedExpressionTypeName(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): Option<String> {
  for (const resolution of evidence.expressionResolutions) {
    if (
      resolution.offset == tree.nodes[index].offset
      && resolution.line == tree.nodes[index].line
      && resolution.column == tree.nodes[index].column
    ) {
      return Option.some(resolution.typeName.copyBytes(
      0,
      resolution.typeName.byteLength
      ));
    }
  }
  return Option<String>.none;
}

function resolvedExpressionTargetName(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): Option<String> {
  for (const resolution of evidence.expressionResolutions) {
    if (
      resolution.offset == tree.nodes[index].offset
      && resolution.line == tree.nodes[index].line
      && resolution.column == tree.nodes[index].column
      && resolution.targetName.byteLength > 0
    ) return Option.some(resolution.targetName.copyBytes(
      0,
      resolution.targetName.byteLength
    ));
  }
  return Option<String>.none;
}

function loweredIntegerSourceType(
  in importedTypes: Array<LoweredImportedType>,
  in sourceType: String
): Option<String> {
  if (
    sourceType == "i32"
    || sourceType == "u8"
    || sourceType == "u32"
    || sourceType == "u64"
    || sourceType == "usize"
  ) return Option.some(sourceType.copyBytes(0, sourceType.byteLength));
  for (const type of importedTypes) {
    if (
      type.kind == LoweredTypeKind.foreignEnumType
      && (
        type.localName == sourceType
        || type.targetName == sourceType
      )
    ) return Option.some(type.underlyingType.copyBytes(
      0,
      type.underlyingType.byteLength
    ));
  }
  return Option<String>.none;
}

function contextualIntrinsicTypeName(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize,
  in sourceName: String
): String {
  if (sourceName != "Option") {
    return sourceName.copyBytes(0, sourceName.byteLength);
  }
  match (resolvedExpressionTypeName(evidence, tree, index)) {
    some(name) => {
      match (genericTypeShape(name)) {
        some(generic) => {
          if (generic.base == "Option") return name;
        }
        none => {}
      }
    }
    none => {}
  }
  return sourceName.copyBytes(0, sourceName.byteLength);
}

function checkedIntegerTypeName(
  in program: Program,
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): String {
  match (resolvedExpressionTypeName(evidence, tree, index)) {
    some(name) => {
      if (
        name == "u8"
        || name == "u32"
        || name == "u64"
        || name == "usize"
        || name == "i32"
      ) return name;
    }
    none => {}
  }
  let candidate = "i32";
  for (const child of tree.nodes[index].children) {
    match (resolvedExpressionTypeName(evidence, tree, child)) {
      some(name) => {
        if (name == "u64") return name;
        if (name == "usize") candidate = "usize";
        if (name == "u32" && candidate != "usize") candidate = "u32";
        if (name == "u8") candidate = "u8";
      }
      none => {}
    }
    if (tree.nodes[child].kind == ExpressionKind.identifierExpression) {
      const childName = tree.nodes[child].value.copyBytes(
        0,
        tree.nodes[child].value.byteLength
      );
      const childOffset = tree.nodes[child].offset;
      match (namedValueTypeName(
        program,
        evidence,
        "",
        childName,
        childOffset
      )) {
        some(name) => {
          if (name == "u64") return name;
          if (name == "usize") candidate = "usize";
          if (name == "u32" && candidate != "usize") candidate = "u32";
          if (name == "u8") candidate = "u8";
        }
        none => {}
      }
    }
  }
  return move candidate;
}

function importedCallTarget(
  in program: Program,
  in localName: String
): Option<String> {
  for (const declaration of program.imports) {
    if (!declaration.selective) continue;
    for (const binding of declaration.bindings) {
      if (binding.localName == localName) return Option.some(
        binding.importedName.copyBytes(0, binding.importedName.byteLength)
      );
    }
  }
  return Option<String>.none;
}

function importedEnumDeclaration(
  in importedTypes: Array<LoweredImportedType>,
  in name: String
): Option<LoweredEnum> {
  let importedIndex = importedTypes.length;
  while (importedIndex > 0) {
    importedIndex = importedIndex - 1;
    if (
      importedTypes[importedIndex].kind != LoweredTypeKind.enumType
      || (
        importedTypes[importedIndex].localName != name
        && importedTypes[importedIndex].targetName != name
      )
    ) continue;
    let variants = Array<LoweredVariant>();
    for (const variant of importedTypes[importedIndex].variants) {
      variants.push(copyLoweredVariant(variant));
    }
    return Option.some(LoweredEnum({
      name: importedTypes[importedIndex].targetName.copyBytes(
        0,
        importedTypes[importedIndex].targetName.byteLength
      ),
      nativeCName: "",
      nativeCUnderlyingType: "",
      variants,
      payloadBearing: importedTypes[importedIndex].payloadBearing,
      needsDeinit: importedTypes[importedIndex].needsDeinit,
    }));
  }
  return Option<LoweredEnum>.none;
}

function importedStructTarget(
  in importedTypes: Array<LoweredImportedType>,
  in name: String
): Option<String> {
  let importedIndex = importedTypes.length;
  while (importedIndex > 0) {
    importedIndex = importedIndex - 1;
    if (
      (
        importedTypes[importedIndex].kind == LoweredTypeKind.structType
        || importedTypes[importedIndex].kind == LoweredTypeKind.classType
      )
      && (
        importedTypes[importedIndex].localName == name
        || importedTypes[importedIndex].targetName == name
      )
    ) return Option.some(importedTypes[importedIndex].targetName.copyBytes(
      0,
      importedTypes[importedIndex].targetName.byteLength
    ));
  }
  return Option<String>.none;
}

function uniquelyResolvedFieldTypeName(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in fieldName: String
): Option<String> {
  let resolved = "";
  for (const aggregate of program.aggregates) {
    for (const field of aggregate.fields) {
      if (field.name != fieldName) continue;
      if (resolved.byteLength == 0) {
        resolved = field.type.name.copyBytes(0, field.type.name.byteLength);
      } else if (resolved != field.type.name) {
        return Option<String>.none;
      }
    }
  }
  for (const imported of importedTypes) {
    for (const field of imported.fields) {
      if (field.name != fieldName) continue;
      const candidate = loweredTypeIdentity(field.type);
      if (resolved.byteLength == 0) {
        resolved = move candidate;
      } else if (resolved != candidate) {
        return Option<String>.none;
      }
    }
  }
  if (resolved.byteLength == 0) return Option<String>.none;
  return Option.some(move resolved);
}

function namedValueTypeName(
  in program: Program,
  in evidence: ModuleSemanticEvidence,
  in ownerName: String,
  in name: String,
  useOffset: usize
): Option<String> {
  let resolved = "";
  let resolvedOffset: usize = 0;
  for (const binding of evidence.bindingResolutions) {
    if (
      binding.name == name
      && binding.offset <= useOffset
      && (
        resolved.byteLength == 0
        || binding.offset >= resolvedOffset
      )
    ) {
      resolved = binding.typeName.copyBytes(0, binding.typeName.byteLength);
      resolvedOffset = binding.offset;
    }
  }
  if (resolved.byteLength > 0) return Option.some(move resolved);
  for (const declaration of program.functions) {
    if (declaration.name != ownerName) continue;
    for (const parameter of declaration.parameters) {
      if (parameter.name == name) {
        return Option.some(parameter.type.name.copyBytes(
          0,
          parameter.type.name.byteLength
        ));
      }
    }
  }
  let methodType = "";
  for (const aggregate of program.aggregates) {
    for (const method of aggregate.methods) {
      if (ownerName.byteLength > 0 && method.name != ownerName) continue;
      for (const parameter of method.parameters) {
        if (parameter.name != name) continue;
        if (methodType.byteLength == 0) {
          methodType = parameter.type.name.copyBytes(
            0,
            parameter.type.name.byteLength
          );
        } else if (methodType != parameter.type.name) {
          return Option<String>.none;
        }
      }
    }
  }
  if (methodType.byteLength > 0) return Option.some(move methodType);
  return Option<String>.none;
}

function fieldTypeNameForOwner(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in ownerTypeName: String,
  in fieldName: String
): Option<String> {
  for (const aggregate of program.aggregates) {
    if (aggregate.name != ownerTypeName) continue;
    for (const field of aggregate.fields) {
      if (field.name == fieldName) {
        return Option.some(field.type.name.copyBytes(
          0,
          field.type.name.byteLength
        ));
      }
    }
  }
  for (const imported of importedTypes) {
    if (
      imported.localName != ownerTypeName
      && imported.targetName != ownerTypeName
    ) continue;
    for (const field of imported.fields) {
      if (field.name == fieldName) {
        return Option.some(loweredTypeIdentity(field.type));
      }
    }
  }
  return Option<String>.none;
}

function fieldIsOptionalForOwner(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in ownerTypeName: String,
  in fieldName: String
): boolean {
  for (const aggregate of program.aggregates) {
    if (aggregate.name != ownerTypeName) continue;
    for (const field of aggregate.fields) {
      if (field.name == fieldName) return field.optionalField;
    }
  }
  for (const imported of importedTypes) {
    if (
      imported.localName != ownerTypeName
      && imported.targetName != ownerTypeName
    ) continue;
    for (const field of imported.fields) {
      if (field.name == fieldName) return field.optionalField;
    }
  }
  return false;
}

function staticallyResolvedExpressionTypeName(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in arena: StatementArena,
  in ownerName: String,
  in tree: ExpressionTree,
  index: usize
): Option<String> {
  match (resolvedExpressionTypeName(evidence, tree, index)) {
    some(name) => {
      if (
        tree.nodes[index].kind != ExpressionKind.memberExpression
        || name != tree.nodes[index].value
      ) return Option.some(move name);
    }
    none => {}
  }
  if (
    tree.nodes[index].kind == ExpressionKind.conditionalExpression
    && tree.nodes[index].children.length == 3
  ) {
    const thenInput = tree.nodes[index].children[1];
    const elseInput = tree.nodes[index].children[2];
    const thenType = staticallyResolvedExpressionTypeName(
      program,
      importedTypes,
      evidence,
      arena,
      ownerName,
      tree,
      thenInput
    );
    const elseType = staticallyResolvedExpressionTypeName(
      program,
      importedTypes,
      evidence,
      arena,
      ownerName,
      tree,
      elseInput
    );
    match (thenType) {
      some(left) => match (elseType) {
        some(right) => {
          if (left == right) {
            return Option.some(left.copyBytes(0, left.byteLength));
          }
        }
        none => {}
      }
      none => {}
    }
  }
  if (
    tree.nodes[index].kind == ExpressionKind.callExpression
    && tree.nodes[index].children.length == 2
  ) {
    const callee = tree.nodes[index].children[0];
    const closure = tree.nodes[index].children[1];
    if (
      tree.nodes[callee].kind == ExpressionKind.memberExpression
      && tree.nodes[callee].value == "spawn"
      && tree.nodes[callee].children.length == 1
      && tree.nodes[closure].kind == ExpressionKind.closureExpression
      && tree.nodes[closure].labels.length >= 1
      && tree.nodes[closure].labels[0].byteLength > 0
    ) {
      const namespace = tree.nodes[callee].children[0];
      if (
        tree.nodes[namespace].kind == ExpressionKind.identifierExpression
        && isImportedStandardBinding(
          program,
          "std/thread",
          "thread",
          tree.nodes[namespace].value
        )
      ) {
        if (
          tree.nodes[closure].labels.length > 1
          && tree.nodes[closure].labels[1].byteLength > 0
        ) return Option.some(
          `Task<${tree.nodes[closure].labels[0]}, ${tree.nodes[closure].labels[1]}>`
        );
        return Option.some(`Task<${tree.nodes[closure].labels[0]}>`);
      }
    }
  }
  if (
    tree.nodes[index].kind == ExpressionKind.attemptExpression
    && tree.nodes[index].children.length == 1
  ) {
    const attempted = tree.nodes[index].children[0];
    if (
      tree.nodes[attempted].kind == ExpressionKind.awaitExpression
      && tree.nodes[attempted].children.length == 1
    ) {
      const task = tree.nodes[attempted].children[0];
      match (staticallyResolvedExpressionTypeName(
        program,
        importedTypes,
        evidence,
        arena,
        ownerName,
        tree,
        task
      )) {
        some(taskTypeName) => match (genericTypeShape(taskTypeName)) {
          some(generic) => {
            if (
              generic.base == "Task"
              && generic.arguments.length == 2
            ) return Option.some(
              `Result<${generic.arguments[0]}, ${generic.arguments[1]}>`
            );
          }
          none => {}
        }
        none => {}
      }
    }
  }
  if (
    tree.nodes[index].kind == ExpressionKind.tryExpression
    && tree.nodes[index].children.length == 1
  ) {
    const attempted = tree.nodes[index].children[0];
    if (
      tree.nodes[attempted].kind == ExpressionKind.awaitExpression
      && tree.nodes[attempted].children.length == 1
    ) {
      const task = tree.nodes[attempted].children[0];
      match (staticallyResolvedExpressionTypeName(
        program,
        importedTypes,
        evidence,
        arena,
        ownerName,
        tree,
        task
      )) {
        some(taskTypeName) => match (genericTypeShape(taskTypeName)) {
          some(generic) => {
            if (
              generic.base == "Task"
              && generic.arguments.length == 2
            ) return Option.some(generic.arguments[0].copyBytes(
              0,
              generic.arguments[0].byteLength
            ));
          }
          none => {}
        }
        none => {}
      }
    }
  }
  if (
    tree.nodes[index].kind == ExpressionKind.awaitExpression
    && tree.nodes[index].children.length == 1
  ) {
    const task = tree.nodes[index].children[0];
    match (staticallyResolvedExpressionTypeName(
      program,
      importedTypes,
      evidence,
      arena,
      ownerName,
      tree,
      task
    )) {
      some(taskTypeName) => match (genericTypeShape(taskTypeName)) {
        some(generic) => {
          if (generic.base == "Task" && generic.arguments.length == 1) {
            return Option.some(generic.arguments[0].copyBytes(
              0,
              generic.arguments[0].byteLength
            ));
          }
        }
        none => {}
      }
      none => {}
    }
  }
  if (
    tree.nodes[index].kind == ExpressionKind.identifierExpression
    || tree.nodes[index].kind == ExpressionKind.argumentBindingExpression
  ) {
    const name = tree.nodes[index].value.copyBytes(
      0,
      tree.nodes[index].value.byteLength
    );
    const offset = tree.nodes[index].offset;
    const named = namedValueTypeName(
      program,
      evidence,
      ownerName,
      name,
      offset
    );
    match (named) {
      some(typeName) => return Option.some(move typeName);
      none => {}
    }
    let declaredType = "";
    let declaredOffset: usize = 0;
    let inferredDeclaration: usize = arena.nodes.length;
    let declarationIndex: usize = 0;
    while (declarationIndex < arena.nodes.length) {
      if (
        arena.nodes[declarationIndex].kind == StatementKind.variableStatement
        && arena.nodes[declarationIndex].name == name
        && arena.nodes[declarationIndex].nameOffset <= offset
        && (
          declaredType.byteLength == 0
          || arena.nodes[declarationIndex].nameOffset >= declaredOffset
        )
      ) {
        match (in arena.nodes[declarationIndex].typeAnnotation) {
          some(annotation) => {
            declaredType = annotation.name.copyBytes(
              0,
              annotation.name.byteLength
            );
            declaredOffset = arena.nodes[declarationIndex].nameOffset;
            inferredDeclaration = arena.nodes.length;
          }
          none => {
            declaredType = "";
            inferredDeclaration = declarationIndex;
            declaredOffset = arena.nodes[declarationIndex].nameOffset;
          }
        }
      }
      declarationIndex = declarationIndex + 1;
    }
    if (declaredType.byteLength > 0) return Option.some(move declaredType);
    if (inferredDeclaration < arena.nodes.length) {
      match (in arena.nodes[inferredDeclaration].expression) {
        some(initializer) => match (in initializer.tree) {
          some(initializerTree) => {
            const initializerRoot = initializerTree.root;
            match (staticallyResolvedExpressionTypeName(
              program,
              importedTypes,
              evidence,
              arena,
              ownerName,
              initializerTree,
              initializerRoot
            )) {
              some(typeName) => return Option.some(move typeName);
              none => {}
            }
          }
          none => {}
        }
        none => {}
      }
    }
    let loopIndex: usize = 0;
    let loopOffset: usize = 0;
    while (loopIndex < arena.nodes.length) {
      if (
        arena.nodes[loopIndex].kind == StatementKind.forStatement
        && arena.nodes[loopIndex].name == name
        && arena.nodes[loopIndex].offset <= offset
        && arena.nodes[loopIndex].offset >= loopOffset
      ) {
        match (in arena.nodes[loopIndex].expression) {
          some(iterable) => match (in iterable.tree) {
            some(iterableTree) => {
              const iterableRoot = iterableTree.root;
              match (staticallyResolvedExpressionTypeName(
                program,
                importedTypes,
                evidence,
                arena,
                ownerName,
                iterableTree,
                iterableRoot
              )) {
                some(iterableType) => {
                  match (genericTypeShape(iterableType)) {
                    some(generic) => {
                      if (
                        generic.base == "Array"
                        && generic.arguments.length == 1
                      ) {
                        return Option.some(generic.arguments[0].copyBytes(
                          0,
                          generic.arguments[0].byteLength
                        ));
                      }
                    }
                    none => {}
                  }
                  if (
                    stringStartsWith(iterableType, "__z_Array_")
                    && iterableType.byteLength > 10
                  ) {
                    return Option.some(iterableType.copyBytes(
                      10,
                      iterableType.byteLength
                    ));
                  }
                }
                none => {}
              }
            }
            none => {}
          }
          none => {}
        }
        loopOffset = arena.nodes[loopIndex].offset;
      }
      loopIndex = loopIndex + 1;
    }
    return Option<String>.none;
  }
  if (
    tree.nodes[index].kind == ExpressionKind.indexExpression
    && tree.nodes[index].children.length == 2
  ) {
    const receiver = tree.nodes[index].children[0];
    match (staticallyResolvedExpressionTypeName(
      program,
      importedTypes,
      evidence,
      arena,
      ownerName,
      tree,
      receiver
    )) {
      some(receiverTypeName) => {
        match (genericTypeShape(receiverTypeName)) {
          some(generic) => {
            if (
              generic.base == "Array"
              && generic.arguments.length == 1
            ) return Option.some(generic.arguments[0].copyBytes(
              0,
              generic.arguments[0].byteLength
            ));
          }
          none => {}
        }
        if (
          stringStartsWith(receiverTypeName, "__z_Array_")
          && receiverTypeName.byteLength > 10
        ) return Option.some(receiverTypeName.copyBytes(
          10,
          receiverTypeName.byteLength
        ));
      }
      none => {}
    }
  }
  if (
    tree.nodes[index].kind == ExpressionKind.memberExpression
    && tree.nodes[index].children.length == 1
  ) {
    const receiver = tree.nodes[index].children[0];
    const fieldName = tree.nodes[index].value.copyBytes(
      0,
      tree.nodes[index].value.byteLength
    );
    match (staticallyResolvedExpressionTypeName(
      program,
      importedTypes,
      evidence,
      arena,
      ownerName,
      tree,
      receiver
    )) {
      some(ownerTypeName) => return fieldTypeNameForOwner(
        program,
        importedTypes,
        ownerTypeName,
        fieldName
      );
      none => {}
    }
  }
  return Option<String>.none;
}

function evidenceResolvedExpressionTypeName(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): Option<String> {
  match (resolvedExpressionTypeName(evidence, tree, index)) {
    some(name) => {
      if (
        tree.nodes[index].kind != ExpressionKind.memberExpression
        || name != tree.nodes[index].value
      ) return Option.some(move name);
    }
    none => {}
  }
  if (tree.nodes[index].kind == ExpressionKind.identifierExpression) {
    const name = tree.nodes[index].value.copyBytes(
      0,
      tree.nodes[index].value.byteLength
    );
    const offset = tree.nodes[index].offset;
    return namedValueTypeName(program, evidence, "", name, offset);
  }
  if (
    tree.nodes[index].kind == ExpressionKind.indexExpression
    && tree.nodes[index].children.length == 2
  ) {
    const receiver = tree.nodes[index].children[0];
    match (evidenceResolvedExpressionTypeName(
      program,
      importedTypes,
      evidence,
      tree,
      receiver
    )) {
      some(receiverTypeName) => {
        match (genericTypeShape(receiverTypeName)) {
          some(generic) => {
            if (
              generic.base == "Array"
              && generic.arguments.length == 1
            ) return Option.some(generic.arguments[0].copyBytes(
              0,
              generic.arguments[0].byteLength
            ));
          }
          none => {}
        }
        if (
          stringStartsWith(receiverTypeName, "__z_Array_")
          && receiverTypeName.byteLength > 10
        ) return Option.some(receiverTypeName.copyBytes(
          10,
          receiverTypeName.byteLength
        ));
      }
      none => {}
    }
  }
  if (
    tree.nodes[index].kind == ExpressionKind.memberExpression
    && tree.nodes[index].children.length == 1
  ) {
    const receiver = tree.nodes[index].children[0];
    const fieldName = tree.nodes[index].value.copyBytes(
      0,
      tree.nodes[index].value.byteLength
    );
    match (evidenceResolvedExpressionTypeName(
      program,
      importedTypes,
      evidence,
      tree,
      receiver
    )) {
      some(ownerTypeName) => return fieldTypeNameForOwner(
        program,
        importedTypes,
        ownerTypeName,
        fieldName
      );
      none => {}
    }
  }
  return Option<String>.none;
}

function lowerPlacedDirectCall(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize,
  inout output: Array<LoweredExpression>
): usize throws String {
  if (
    tree.nodes[index].kind != ExpressionKind.callExpression
    || tree.nodes[index].children.length == 0
  ) throw "native main placement requires one direct call";
  const calleeInput = tree.nodes[index].children[0];
  if (tree.nodes[calleeInput].kind != ExpressionKind.identifierExpression) {
    throw "native main placement currently requires a direct Z function call";
  }
  let target = "";
  match (resolvedCallTarget(evidence, tree, index)) {
    some(name) => target = move name;
    none => match (importedCallTarget(
      program,
      tree.nodes[calleeInput].value
    )) {
      some(name) => target = move name;
      none => {}
    }
  }
  if (target.byteLength == 0) {
    throw "native main placement could not resolve its direct Z function";
  }
  const callee = pushExpression(
    inout output,
    LoweredExpressionKind.localValue,
    target,
    Array<usize>(),
    Array<String>()
  );
  const parameterModes = resolvedCallParameterModes(
    program,
    evidence,
    tree,
    index
  );
  let labels = Array<String>();
  for (const mode of parameterModes) {
    labels.push(mode.copyBytes(0, mode.byteLength));
  }
  let children = Array<usize>();
  children.push(callee);
  let argument: usize = 1;
  while (argument < tree.nodes[index].children.length) {
    const argumentInput = tree.nodes[index].children[argument];
    let value = try lowerExpression(
      program,
      importedTypes,
      evidence,
      tree,
      argumentInput,
      inout output
    );
    if (
      parameterModes.length >= argument
      && parameterModes[argument - 1] == "value"
    ) value = wrapImplicitOwnedTransfer(
      tree,
      argumentInput,
      value,
      inout output
    );
    children.push(value);
    argument = argument + 1;
  }
  return pushExpression(
    inout output,
    LoweredExpressionKind.directCall,
    "",
    children,
    labels
  );
}

function lowerExpression(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize,
  inout output: Array<LoweredExpression>
): usize throws String {
  match (resolvedExpressionTargetName(evidence, tree, index)) {
    some(targetName) => return pushExpression(
      inout output,
      LoweredExpressionKind.foreignValue,
      targetName,
      Array<usize>(),
      Array<String>()
    );
    none => {}
  }
  if (
    tree.nodes[index].kind
      == ExpressionKind.executorPlacementExpression
  ) {
    if (
      tree.nodes[index].value != "await"
      || tree.nodes[index].labels.length < 3
      || tree.nodes[index].labels[2] != "call"
      || tree.nodes[index].children.length != 3
    ) {
      throw "native executor placement lowering currently supports direct `await on thread.main` calls";
    }
    const executorInput = tree.nodes[index].children[1];
    if (
      tree.nodes[executorInput].kind != ExpressionKind.memberExpression
      || tree.nodes[executorInput].value != "main"
      || tree.nodes[executorInput].children.length != 1
    ) throw "native executor placement lowering currently requires thread.main";
    const executorNamespace = tree.nodes[executorInput].children[0];
    if (
      tree.nodes[executorNamespace].kind
        != ExpressionKind.identifierExpression
      || !isImportedStandardBinding(
        program,
        "std/thread",
        "thread",
        tree.nodes[executorNamespace].value
      )
    ) throw "native executor placement lowering currently requires imported thread.main";
    const callInput = tree.nodes[index].children[2];
    if (tree.nodes[callInput].kind != ExpressionKind.callExpression) {
      throw "native executor placement lowering requires one direct call";
    }
    let callReturnType = "";
    let callErrorType = "";
    for (const resolution of evidence.callResolutions) {
      if (
        resolution.offset == tree.nodes[callInput].offset
        && resolution.line == tree.nodes[callInput].line
        && resolution.column == tree.nodes[callInput].column
      ) {
        callReturnType = resolution.returnType.copyBytes(
          0,
          resolution.returnType.byteLength
        );
        callErrorType = resolution.errorType.copyBytes(
          0,
          resolution.errorType.byteLength
        );
      }
    }
    let returnType = try lowerModuleTypeName(
      program,
      importedTypes,
      callReturnType
    );
    if (callErrorType.byteLength > 0) {
      const errorType = try lowerModuleTypeName(
        program,
        importedTypes,
        callErrorType
      );
      returnType = LoweredType({
        kind: LoweredTypeKind.enumType,
        name: intrinsicResultName(returnType, errorType),
      });
    }
    const parameterTypes = resolvedCallParameterTypes(
      evidence,
      tree,
      callInput
    );
    const parameterModes = resolvedCallParameterModes(
      program,
      evidence,
      tree,
      callInput
    );
    const loweredCall = try lowerPlacedDirectCall(
      program,
      importedTypes,
      evidence,
      tree,
      callInput,
      inout output
    );
    if (
      output[loweredCall].kind != LoweredExpressionKind.directCall
      || output[loweredCall].children.length == 0
      || output[loweredCall].children.length != parameterTypes.length + 1
      || parameterModes.length != parameterTypes.length
    ) throw "native main placement currently requires one resolved direct Z call";
    let runnerChildren = Array<usize>();
    runnerChildren.push(output[loweredCall].children[0]);
    let labels = Array<String>();
    labels.push(loweredTypeIdentity(returnType));
    let argument: usize = 0;
    while (argument < parameterTypes.length) {
      if (parameterModes[argument] != "value") {
        throw "native main placement currently requires value parameters";
      }
      const parameterType = try lowerModuleTypeName(
        program,
        importedTypes,
        parameterTypes[argument]
      );
      labels.push(loweredTypeIdentity(parameterType));
      const parameterName = `_z_stage1_main_argument_${argument}`;
      const parameterValue = pushExpression(
        inout output,
        LoweredExpressionKind.parameterValue,
        parameterName,
        Array<usize>(),
        Array<String>()
      );
      runnerChildren.push(parameterValue);
      argument = argument + 1;
    }
    let runnerLabels = Array<String>();
    for (const label of output[loweredCall].labels) {
      runnerLabels.push(label.copyBytes(0, label.byteLength));
    }
    const runnerCall = pushExpression(
      inout output,
      LoweredExpressionKind.directCall,
      "",
      runnerChildren,
      runnerLabels
    );
    let children = Array<usize>();
    children.push(runnerCall);
    argument = 1;
    while (argument < output[loweredCall].children.length) {
      children.push(output[loweredCall].children[argument]);
      argument = argument + 1;
    }
    return pushExpression(
      inout output,
      LoweredExpressionKind.threadMainCall,
      "",
      children,
      labels
    );
  }
  if (tree.nodes[index].kind == ExpressionKind.identifierExpression) {
    const kind = tree.nodes[index].value == "this"
      ? LoweredExpressionKind.receiverValue
      : LoweredExpressionKind.localValue;
    let labels = Array<String>();
    match (resolvedExpressionTypeName(evidence, tree, index)) {
      some(typeName) => labels.push(move typeName);
      none => {}
    }
    return pushExpression(
      inout output,
      kind,
      tree.nodes[index].value,
      Array<usize>(),
      labels
    );
  }
  if (
    tree.nodes[index].kind == ExpressionKind.argumentBindingExpression
  ) {
    return pushExpression(
      inout output,
      LoweredExpressionKind.localValue,
      tree.nodes[index].value,
      Array<usize>(),
      Array<String>()
    );
  }
  if (
    tree.nodes[index].kind == ExpressionKind.argumentReferenceExpression
    && tree.nodes[index].children.length == 1
  ) {
    const binding = tree.nodes[index].children[0];
    return try lowerExpression(
      program,
      importedTypes,
      evidence,
      tree,
      binding,
      inout output
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
  if (tree.nodes[index].kind == ExpressionKind.stringExpression) {
    return pushExpression(
      inout output,
      LoweredExpressionKind.stringValue,
      tree.nodes[index].value,
      Array<usize>(),
      Array<String>()
    );
  }
  if (tree.nodes[index].kind == ExpressionKind.templateExpression) {
    let children = Array<usize>();
    let labels = Array<String>();
    for (const childInput of tree.nodes[index].children) {
      if (
        tree.nodes[childInput].kind == ExpressionKind.templateTextExpression
      ) {
        children.push(pushExpression(
          inout output,
          LoweredExpressionKind.stringValue,
          tree.nodes[childInput].value,
          Array<usize>(),
          Array<String>()
        ));
        labels.push("text");
        continue;
      }
      const child = try lowerExpression(
        program,
        importedTypes,
        evidence,
        tree,
        childInput,
        inout output
      );
      children.push(child);
      let typeName = "";
      match (resolvedExpressionTypeName(evidence, tree, childInput)) {
        some(resolved) => typeName = move resolved;
        none => {
          if (
            tree.nodes[childInput].kind == ExpressionKind.stringExpression
          ) typeName = "String";
          else if (
            tree.nodes[childInput].kind == ExpressionKind.booleanExpression
          ) typeName = "boolean";
          else if (
            tree.nodes[childInput].kind == ExpressionKind.numberExpression
          ) typeName = "i32";
        }
      }
      if (
        typeName.byteLength == 0
        && tree.nodes[childInput].kind == ExpressionKind.memberExpression
      ) {
        match (uniquelyResolvedFieldTypeName(
          program,
          importedTypes,
          tree.nodes[childInput].value
        )) {
          some(resolved) => typeName = move resolved;
          none => {}
        }
      }
      if (
        typeName != "String"
        && typeName != "view String"
        && typeName != "boolean"
        && typeName != "i32"
        && typeName != "u8"
        && typeName != "usize"
      ) {
        const childKind = expressionKindName(tree.nodes[childInput].kind);
        throw `native template lowering does not support ${childKind} interpolation of ${typeName} at ${tree.nodes[childInput].line}:${tree.nodes[childInput].column}`;
      }
      labels.push(typeName);
    }
    return pushExpression(
      inout output,
      LoweredExpressionKind.templateValue,
      "",
      children,
      labels
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
  if (tree.nodes[index].kind == ExpressionKind.newExpression) {
    let className = tree.nodes[index].value.copyBytes(
      0,
      tree.nodes[index].value.byteLength
    );
    match (importedStructTarget(importedTypes, tree.nodes[index].value)) {
      some(target) => {
        className = move target;
      }
      none => {}
    }
    const classType = try lowerModuleTypeName(
      program,
      importedTypes,
      tree.nodes[index].value
    );
    if (classType.kind != LoweredTypeKind.classType) {
      throw `native new lowering requires a class, found ${tree.nodes[index].value}`;
    }
    if (tree.nodes[index].children.length != 1) {
      throw "native class construction requires one object initializer";
    }
    const objectInput = tree.nodes[index].children[0];
    if (
      tree.nodes[objectInput].kind != ExpressionKind.objectExpression
      || tree.nodes[objectInput].children.length
        != tree.nodes[objectInput].labels.length
    ) {
      throw "native class construction requires an object initializer";
    }
    let children = Array<usize>();
    let labels = Array<String>();
    let field: usize = 0;
    while (field < tree.nodes[objectInput].children.length) {
      const fieldName = tree.nodes[objectInput].labels[field].copyBytes(
        0,
        tree.nodes[objectInput].labels[field].byteLength
      );
      const fieldType = match (fieldTypeNameForOwner(
        program,
        importedTypes,
        tree.nodes[index].value,
        fieldName
      )) {
        some(name) => name;
        none => throw `native class lowering could not resolve ${className}.${fieldName}`;
      };
      const valueInput = tree.nodes[objectInput].children[field];
      let value = try lowerExpressionExpected(
        program,
        importedTypes,
        evidence,
        tree,
        valueInput,
        fieldType,
        inout output
      );
      value = wrapImplicitOwnedTransfer(
        tree,
        valueInput,
        value,
        inout output
      );
      children.push(value);
      labels.push(fieldName);
      field = field + 1;
    }
    return pushExpression(
      inout output,
      LoweredExpressionKind.classValue,
      className,
      children,
      labels
    );
  }
  if (
    tree.nodes[index].kind == ExpressionKind.attemptExpression
    && tree.nodes[index].children.length == 1
  ) {
    const attempted = tree.nodes[index].children[0];
    return try lowerExpression(
      program,
      importedTypes,
      evidence,
      tree,
      attempted,
      inout output
    );
  }
  if (tree.nodes[index].kind == ExpressionKind.tryExpression) {
    const bindingName = `_z_stage1_nested_try_${tree.nodes[index].offset}`;
    let nestedTryCandidateIndex: usize = 0;
    while (nestedTryCandidateIndex < output.length) {
      if (
        output[nestedTryCandidateIndex].kind
          == LoweredExpressionKind.localValue
        && output[nestedTryCandidateIndex].value == bindingName
        && expressionHasLabel(
          output[nestedTryCandidateIndex],
          "nested-try-binding"
        )
      ) return nestedTryCandidateIndex;
      nestedTryCandidateIndex = nestedTryCandidateIndex + 1;
    }
    throw `native lowering does not support nested try propagation at ${tree.nodes[index].line}:${tree.nodes[index].column} yet`;
  }
  if (tree.nodes[index].kind == ExpressionKind.unaryExpression) {
    if (tree.nodes[index].children.length != 1) {
      throw "native lowering received a malformed unary expression";
    }
    const operandInput = tree.nodes[index].children[0];
    const operand = try lowerExpression(
      program,
      importedTypes,
      evidence,
      tree,
      operandInput,
      inout output
    );
    let kind = LoweredExpressionKind.unaryOperation;
    if (tree.nodes[index].value == "-") {
      kind = LoweredExpressionKind.checkedNegateInteger;
    }
    else if (tree.nodes[index].value == "move") kind = LoweredExpressionKind.moveValue;
    else if (tree.nodes[index].value == "copy") {
      const operandType = match (
        resolvedExpressionTypeName(evidence, tree, operandInput)
      ) {
        some(name) => name;
        none => throw "native copy lowering could not resolve its operand type";
      };
      if (operandType != "String") {
        throw `native copy lowering does not support ${operandType} yet`;
      }
      kind = LoweredExpressionKind.copyValue;
    }
    else if (tree.nodes[index].value == "view") {
      const operandTypeName = match (evidenceResolvedExpressionTypeName(
        program,
        importedTypes,
        evidence,
        tree,
        operandInput
      )) {
        some(name) => name;
        none => throw "native view lowering could not resolve its projected type";
      };
      const operandType = try lowerModuleTypeName(
        program,
        importedTypes,
        operandTypeName
      );
      if (
        operandType.kind != LoweredTypeKind.structType
        && operandType.kind != LoweredTypeKind.arrayType
        && operandType.kind != LoweredTypeKind.stringType
      ) {
        throw `native view lowering currently supports value-struct, Array, and String projections, found ${operandTypeName}`;
      }
      kind = LoweredExpressionKind.viewProjection;
    }
    else if (
      tree.nodes[index].value != "!"
      && tree.nodes[index].value != "+"
      && tree.nodes[index].value != "~"
      && tree.nodes[index].value != "move"
      && tree.nodes[index].value != "copy"
      && tree.nodes[index].value != "view"
    ) {
      throw `native lowering does not support unary operator ${tree.nodes[index].value} at ${tree.nodes[index].line}:${tree.nodes[index].column} yet`;
    }
    let children = Array<usize>();
    children.push(operand);
    const operation = kind == LoweredExpressionKind.checkedNegateInteger
      ? checkedIntegerTypeName(program, evidence, tree, index)
      : tree.nodes[index].value.copyBytes(
        0,
        tree.nodes[index].value.byteLength
      );
    return pushExpression(
      inout output,
      kind,
      operation,
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
    const left = try lowerExpression(
      program,
      importedTypes,
      evidence,
      tree,
      leftInput,
      inout output
    );
    const right = try lowerExpression(
      program,
      importedTypes,
      evidence,
      tree,
      rightInput,
      inout output
    );
    let kind = LoweredExpressionKind.binaryOperation;
    const leftType = resolvedExpressionTypeName(
      evidence,
      tree,
      leftInput
    );
    const rightType = resolvedExpressionTypeName(
      evidence,
      tree,
      rightInput
    );
    let comparesString = false;
    match (in leftType) {
      some(name) => comparesString = name == "String";
      none => {}
    }
    if (!comparesString) {
      match (in rightType) {
        some(name) => comparesString = name == "String";
        none => {}
      }
    }
    if (
      (
        tree.nodes[index].value == "=="
        || tree.nodes[index].value == "!="
      )
      && (
        comparesString
        ||
        tree.nodes[leftInput].kind == ExpressionKind.stringExpression
        || tree.nodes[rightInput].kind == ExpressionKind.stringExpression
      )
    ) kind = LoweredExpressionKind.stringEqual;
    else if (tree.nodes[index].value == "+") {
      kind = LoweredExpressionKind.checkedAddInteger;
    } else if (tree.nodes[index].value == "-") {
      kind = LoweredExpressionKind.checkedSubtractInteger;
    } else if (tree.nodes[index].value == "*") {
      kind = LoweredExpressionKind.checkedMultiplyInteger;
    } else if (tree.nodes[index].value == "/") {
      kind = LoweredExpressionKind.checkedDivideInteger;
    } else if (tree.nodes[index].value == "%") {
      kind = LoweredExpressionKind.checkedRemainderInteger;
    } else if (tree.nodes[index].value == "<<") {
      kind = LoweredExpressionKind.checkedShiftLeftInteger;
    } else if (tree.nodes[index].value == ">>") {
      kind = LoweredExpressionKind.checkedShiftRightInteger;
    }
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
      && tree.nodes[index].value != "<<"
      && tree.nodes[index].value != ">>"
    ) {
      throw `native lowering does not support binary operator ${tree.nodes[index].value} yet`;
    }
    let children = Array<usize>();
    children.push(left);
    children.push(right);
    let labels = Array<String>();
    if (kind == LoweredExpressionKind.stringEqual) {
      match (in leftType) {
        some(name) => {
          if (stringStartsWith(name, "view ")) labels.push("view");
          else labels.push("value");
        }
        none => labels.push("value");
      }
      match (in rightType) {
        some(name) => {
          if (stringStartsWith(name, "view ")) labels.push("view");
          else labels.push("value");
        }
        none => labels.push("value");
      }
    }
    const operation = (
      kind == LoweredExpressionKind.checkedAddInteger
      || kind == LoweredExpressionKind.checkedSubtractInteger
      || kind == LoweredExpressionKind.checkedMultiplyInteger
      || kind == LoweredExpressionKind.checkedDivideInteger
      || kind == LoweredExpressionKind.checkedRemainderInteger
      || kind == LoweredExpressionKind.checkedShiftLeftInteger
      || kind == LoweredExpressionKind.checkedShiftRightInteger
    )
      ? checkedIntegerTypeName(program, evidence, tree, index)
      : tree.nodes[index].value.copyBytes(
        0,
        tree.nodes[index].value.byteLength
      );
    return pushExpression(
      inout output,
      kind,
      operation,
      children,
      labels
    );
  }
  if (tree.nodes[index].kind == ExpressionKind.conditionalExpression) {
    if (tree.nodes[index].children.length != 3) {
      throw "native lowering received a malformed conditional expression";
    }
    const thenInput = tree.nodes[index].children[1];
    const elseInput = tree.nodes[index].children[2];
    if (
      expressionTreeContainsTry(tree, thenInput)
      || expressionTreeContainsTry(tree, elseInput)
    ) {
      const bindingName =
        `_z_stage1_nested_conditional_${tree.nodes[index].offset}`;
      let nestedConditionalCandidate: usize = 0;
      while (nestedConditionalCandidate < output.length) {
        if (
          output[nestedConditionalCandidate].kind
            == LoweredExpressionKind.localValue
          && output[nestedConditionalCandidate].value == bindingName
          && expressionHasLabel(
            output[nestedConditionalCandidate],
            "nested-conditional-binding"
          )
        ) return nestedConditionalCandidate;
        nestedConditionalCandidate = nestedConditionalCandidate + 1;
      }
      throw `native lowering did not normalize selected conditional propagation at ${tree.nodes[index].line}:${tree.nodes[index].column}`;
    }
    let children = Array<usize>();
    for (const childInput of tree.nodes[index].children) {
      const child = try lowerExpression(
        program,
        importedTypes,
        evidence,
        tree,
        childInput,
        inout output
      );
      children.push(child);
    }
    return pushExpression(
      inout output,
      LoweredExpressionKind.conditionalValue,
      "",
      children,
      Array<String>()
    );
  }
  if (tree.nodes[index].kind == ExpressionKind.awaitExpression) {
    if (tree.nodes[index].children.length != 1) {
      throw "native lowering received a malformed await expression";
    }
    const taskInput = tree.nodes[index].children[0];
    let taskName = "";
    match (evidenceResolvedExpressionTypeName(
      program,
      importedTypes,
      evidence,
      tree,
      taskInput
    )) {
      some(taskTypeName) => match (genericTypeShape(taskTypeName)) {
        some(generic) => {
          if (
            generic.base != "Task"
            || (generic.arguments.length != 1 && generic.arguments.length != 2)
          ) {
            throw `native await lowering currently supports Task<T> or Task<T, E>, found ${taskTypeName}`;
          }
          const successType = try lowerModuleTypeName(
            program,
            importedTypes,
            generic.arguments[0]
          );
          let resultType = LoweredType({
            kind: successType.kind,
            name: successType.name.copyBytes(0, successType.name.byteLength),
          });
          if (generic.arguments.length == 2) {
            const errorType = try lowerModuleTypeName(
              program,
              importedTypes,
              generic.arguments[1]
            );
            resultType = LoweredType({
              kind: LoweredTypeKind.enumType,
              name: intrinsicResultName(successType, errorType),
            });
          }
          taskName = intrinsicTaskName(resultType);
        }
        none => throw `native await lowering currently supports Task<T>, found ${taskTypeName}`;
      }
      none => {}
    }
    const task = try lowerExpression(
      program,
      importedTypes,
      evidence,
      tree,
      taskInput,
      inout output
    );
    let children = Array<usize>();
    children.push(task);
    return pushExpression(
      inout output,
      LoweredExpressionKind.threadAwait,
      taskName,
      children,
      Array<String>()
    );
  }
  if (tree.nodes[index].kind == ExpressionKind.callExpression) {
    if (tree.nodes[index].children.length == 0) {
      throw "native lowering received a malformed call expression";
    }
    if (resolvedCallIsAsynchronous(evidence, tree, index)) {
      throw "native lowering requires an explicit supported placement for async function calls";
    }
    const calleeInput = tree.nodes[index].children[0];
    if (
      tree.nodes[calleeInput].kind == ExpressionKind.memberExpression
      && tree.nodes[calleeInput].value == "spawn"
      && tree.nodes[calleeInput].children.length == 1
      && tree.nodes[index].children.length == 2
    ) {
      const namespaceInput = tree.nodes[calleeInput].children[0];
      if (
        tree.nodes[namespaceInput].kind == ExpressionKind.identifierExpression
        && isImportedStandardBinding(
          program,
          "std/thread",
          "thread",
          tree.nodes[namespaceInput].value
        )
      ) {
        const closureInput = tree.nodes[index].children[1];
        if (
          tree.nodes[closureInput].kind != ExpressionKind.closureExpression
          || tree.nodes[closureInput].labels.length < 4
        ) throw "native thread.spawn lowering requires one inline closure";
        for (const child of tree.nodes[closureInput].children) {
          if (
            tree.nodes[child].kind
              == ExpressionKind.closureParameterExpression
          ) throw "native thread.spawn lowering currently requires a zero-parameter closure";
        }
        const resultTypeName = tree.nodes[closureInput].labels[0].copyBytes(
          0,
          tree.nodes[closureInput].labels[0].byteLength
        );
        if (resultTypeName.byteLength == 0) {
          throw "native thread.spawn lowering currently requires an explicit worker result type";
        }
        const resultType = try lowerModuleTypeName(
          program,
          importedTypes,
          resultTypeName
        );
        if (resultType.kind == LoweredTypeKind.voidType) {
          throw "native thread.spawn lowering currently requires a non-void result";
        }
        const resultPath = Array<String>();
        if (!moduleTypeIsWorkerDestructible(
          program,
          importedTypes,
          resultTypeName,
          resultPath
        )) {
          throw `native thread.spawn cannot transfer worker result ${resultTypeName} to its owner thread yet`;
        }
        const errorTypeName = tree.nodes[closureInput].labels[1].copyBytes(
          0,
          tree.nodes[closureInput].labels[1].byteLength
        );
        let storageResultType = LoweredType({
          kind: resultType.kind,
          name: resultType.name.copyBytes(0, resultType.name.byteLength),
        });
        if (errorTypeName.byteLength > 0) {
          const errorType = try lowerModuleTypeName(
            program,
            importedTypes,
            errorTypeName
          );
          const errorPath = Array<String>();
          if (!moduleTypeIsWorkerDestructible(
            program,
            importedTypes,
            errorTypeName,
            errorPath
          )) {
            throw `native thread.spawn cannot transfer worker error ${errorTypeName} to its owner thread yet`;
          }
          storageResultType = LoweredType({
            kind: LoweredTypeKind.enumType,
            name: intrinsicResultName(resultType, errorType),
          });
        }
        const bodyKind = tree.nodes[closureInput].labels[2].copyBytes(
          0,
          tree.nodes[closureInput].labels[2].byteLength
        );
        let children = Array<usize>();
        let captures = Array<LoweredClosureCapture>();
        if (bodyKind == "expression") {
          const bodyStart = output.length;
          let bodyInput: usize = tree.nodes.length;
          for (const child of tree.nodes[closureInput].children) {
            if (
              tree.nodes[child].kind
                != ExpressionKind.closureParameterExpression
            ) bodyInput = child;
          }
          if (bodyInput >= tree.nodes.length) {
            throw "native thread.spawn lowering lost its worker expression";
          }
          let body = try lowerExpressionExpected(
            program,
            importedTypes,
            evidence,
            tree,
            bodyInput,
            resultTypeName,
            inout output
          );
          if (errorTypeName.byteLength > 0) {
            let successChildren = Array<usize>();
            successChildren.push(body);
            let successLabels = Array<String>();
            successLabels.push("success");
            body = pushExpression(
              inout output,
              LoweredExpressionKind.enumPayloadValue,
              storageResultType.name,
              successChildren,
              successLabels
            );
          }
          const noStatements = Array<LoweredStatement>();
          captures = try collectThreadClosureCaptures(
            program,
            importedTypes,
            evidence,
            "",
            output,
            bodyStart,
            noStatements,
            0,
            tree.nodes[closureInput].offset
          );
          try validateOwnedThreadCaptures(
            captures,
            tree.nodes[closureInput].value,
            output,
            bodyStart
          );
          for (const capture of captures) {
            rewriteClosureParameterValues(
              inout output,
              bodyStart,
              capture.name
            );
          }
          const bodyEnd = output.length;
          attachThreadCaptureMoveFlags(
            inout output,
            bodyStart,
            bodyEnd,
            captures
          );
          markWorkerOwnedMoveRange(
            inout output,
            bodyStart,
            bodyEnd
          );
          children.push(body);
        } else if (bodyKind != "block") {
          throw "native thread.spawn lowering received an unknown closure body shape";
        }
        let labels = Array<String>();
        labels.push(copy bodyKind);
        labels.push(loweredTypeIdentity(storageResultType));
        labels.push(tree.nodes[closureInput].labels[3].copyBytes(
          0,
          tree.nodes[closureInput].labels[3].byteLength
        ));
        labels.push(move errorTypeName);
        labels.push(tree.nodes[closureInput].value.copyBytes(
          0,
          tree.nodes[closureInput].value.byteLength
        ));
        for (const capture of captures) {
          labels.push(capture.name.copyBytes(
            0,
            capture.name.byteLength
          ));
          labels.push(loweredTypeIdentity(capture.type));
          const captureValue = pushThreadCaptureValue(
            inout output,
            capture
          );
          children.push(captureValue);
        }
        const taskName = intrinsicTaskName(storageResultType);
        const lowered = pushExpression(
          inout output,
          LoweredExpressionKind.threadSpawn,
          taskName,
          children,
          labels
        );
        if (bodyKind == "block") {
          for (const sourceStatement of tree.nodes[closureInput].statements) {
            output[lowered].statements.push(sourceStatement);
          }
        }
        return lowered;
      }
    }
    if (
      tree.nodes[calleeInput].kind == ExpressionKind.identifierExpression
      && tree.nodes[index].children.length == 2
    ) {
      let bindingName = tree.nodes[calleeInput].value.copyBytes(
        0,
        tree.nodes[calleeInput].value.byteLength
      );
      match (genericTypeShape(bindingName)) {
        some(generic) => bindingName = generic.base.copyBytes(
          0,
          generic.base.byteLength
        );
        none => {}
      }
      if (isImportedStandardBinding(
        program,
        "std/sync",
        "Mutex",
        bindingName
      )) {
        let valueTypeName = "";
        match (genericTypeShape(tree.nodes[calleeInput].value)) {
          some(generic) => {
            if (generic.arguments.length == 1) {
              valueTypeName = generic.arguments[0].copyBytes(
                0,
                generic.arguments[0].byteLength
              );
            }
          }
          none => {}
        }
        const valueInput = tree.nodes[index].children[1];
        if (valueTypeName.byteLength == 0) {
          match (evidenceResolvedExpressionTypeName(
            program,
            importedTypes,
            evidence,
            tree,
            valueInput
          )) {
            some(name) => valueTypeName = move name;
            none => {
              if (
                tree.nodes[valueInput].kind == ExpressionKind.callExpression
                && tree.nodes[valueInput].children.length > 0
              ) {
                const valueCallee = tree.nodes[valueInput].children[0];
                if (
                  tree.nodes[valueCallee].kind
                    == ExpressionKind.identifierExpression
                ) {
                  const candidateName = tree.nodes[valueCallee].value.copyBytes(
                    0,
                    tree.nodes[valueCallee].value.byteLength
                  );
                  const candidate = attempt lowerModuleTypeName(
                    program,
                    importedTypes,
                    candidateName
                  );
                  match (candidate) {
                    success(type) => {
                      if (
                        type.kind == LoweredTypeKind.structType
                        || type.kind == LoweredTypeKind.classType
                      ) valueTypeName = move candidateName;
                    }
                    failure(_) => {}
                  }
                }
              }
            }
          }
          if (valueTypeName.byteLength == 0) {
            throw "native Mutex construction could not resolve its payload type";
          }
        }
        const valueType = try lowerModuleTypeName(
          program,
          importedTypes,
          valueTypeName
        );
        let value = try lowerExpressionExpected(
          program,
          importedTypes,
          evidence,
          tree,
          valueInput,
          valueTypeName,
          inout output
        );
        value = wrapImplicitOwnedTransfer(
          tree,
          valueInput,
          value,
          inout output
        );
        let children = Array<usize>();
        children.push(value);
        const mutexName = intrinsicMutexName(valueType);
        return pushExpression(
          inout output,
          LoweredExpressionKind.mutexValue,
          mutexName,
          children,
          Array<String>()
        );
      }
    }
    if (
      tree.nodes[calleeInput].kind == ExpressionKind.memberExpression
      && tree.nodes[calleeInput].children.length == 1
    ) {
      const receiverInput = tree.nodes[calleeInput].children[0];
      const receiverTypeName = match (evidenceResolvedExpressionTypeName(
        program,
        importedTypes,
        evidence,
        tree,
        receiverInput
      )) {
        some(name) => name;
        none => "";
      };
      match (genericTypeShape(receiverTypeName)) {
        some(generic) => {
          if (
            generic.base == "Once"
            && generic.arguments.length == 1
            && (
              tree.nodes[calleeInput].value == "initialize"
              || tree.nodes[calleeInput].value == "get"
            )
          ) {
            const valueType = try lowerModuleTypeName(
              program,
              importedTypes,
              generic.arguments[0]
            );
            const receiver = try lowerExpression(
              program,
              importedTypes,
              evidence,
              tree,
              receiverInput,
              inout output
            );
            let children = Array<usize>();
            children.push(receiver);
            if (tree.nodes[calleeInput].value == "initialize") {
              if (tree.nodes[index].children.length != 2) {
                throw "Once.initialize requires one class value";
              }
              const valueInput = tree.nodes[index].children[1];
              let value = try lowerExpressionExpected(
                program,
                importedTypes,
                evidence,
                tree,
                valueInput,
                generic.arguments[0],
                inout output
              );
              value = wrapImplicitOwnedTransfer(
                tree,
                valueInput,
                value,
                inout output
              );
              children.push(value);
              const onceName = intrinsicOnceName(valueType);
              return pushExpression(
                inout output,
                LoweredExpressionKind.onceInitialize,
                onceName,
                children,
                Array<String>()
              );
            }
            if (tree.nodes[index].children.length != 1) {
              throw "Once.get takes no arguments";
            }
            const onceName = intrinsicOnceName(valueType);
            return pushExpression(
              inout output,
              LoweredExpressionKind.onceGet,
              onceName,
              children,
              Array<String>()
            );
          }
          if (
            generic.base == "Mutex"
            && generic.arguments.length == 1
            && tree.nodes[calleeInput].value == "withLock"
          ) {
            if (tree.nodes[index].children.length != 2) {
              throw "Mutex.withLock expects one inline closure";
            }
            const closureInput = tree.nodes[index].children[1];
            if (
              tree.nodes[closureInput].kind
                != ExpressionKind.closureExpression
            ) throw "Mutex.withLock expects one inline closure";
            if (tree.nodes[closureInput].labels.length < 3) {
              throw "native Mutex.withLock lowering could not resolve the closure body shape";
            }
            const bodyKind = tree.nodes[closureInput].labels[2].copyBytes(
              0,
              tree.nodes[closureInput].labels[2].byteLength
            );
            let parameterInput: usize = tree.nodes.length;
            let bodyInput: usize = tree.nodes.length;
            for (const child of tree.nodes[closureInput].children) {
              if (
                tree.nodes[child].kind
                  == ExpressionKind.closureParameterExpression
              ) parameterInput = child;
              else bodyInput = child;
            }
            if (parameterInput >= tree.nodes.length) {
              throw "native Mutex.withLock lowering requires one closure parameter";
            }
            if (
              bodyKind == "expression"
              && bodyInput >= tree.nodes.length
            ) throw "native Mutex.withLock lowering requires an expression body";
            const parameterMode = tree.nodes[parameterInput].labels[0].copyBytes(
              0,
              tree.nodes[parameterInput].labels[0].byteLength
            );
            if (parameterMode != "in" && parameterMode != "inout") {
              throw "native Mutex.withLock closure parameters require `in` or `inout`";
            }
            const resultTypeName = match (
              evidenceResolvedExpressionTypeName(
                program,
                importedTypes,
                evidence,
                tree,
                index
              )
            ) {
              some(name) => name;
              none => tree.nodes[closureInput].labels[0].copyBytes(
                0,
                tree.nodes[closureInput].labels[0].byteLength
              );
            };
            if (resultTypeName.byteLength == 0) {
              throw "native Mutex.withLock lowering could not resolve its result type";
            }
            const resultType = try lowerModuleTypeName(
              program,
              importedTypes,
              resultTypeName
            );
            if (moduleTypeNeedsCleanup(program, importedTypes, resultType)) {
              throw "native Mutex.withLock lowering currently requires a cleanup-free result";
            }
            const receiver = try lowerExpression(
              program,
              importedTypes,
              evidence,
              tree,
              receiverInput,
              inout output
            );
            const parameterName = tree.nodes[parameterInput].value.copyBytes(
              0,
              tree.nodes[parameterInput].value.byteLength
            );
            const valueType = try lowerModuleTypeName(
              program,
              importedTypes,
              generic.arguments[0]
            );
            let children = Array<usize>();
            children.push(receiver);
            let captures = Array<LoweredClosureCapture>();
            if (bodyKind == "expression") {
              const bodyStart = output.length;
              const body = try lowerExpression(
                program,
                importedTypes,
                evidence,
                tree,
                bodyInput,
                inout output
              );
              captures = try collectMutexClosureCaptures(
                program,
                importedTypes,
                evidence,
                "",
                output,
                bodyStart,
                parameterName,
                tree.nodes[closureInput].offset
              );
              rewriteClosureParameterValues(
                inout output,
                bodyStart,
                parameterName
              );
              for (const capture of captures) {
                rewriteClosureParameterValues(
                  inout output,
                  bodyStart,
                  capture.name
                );
              }
              children.push(body);
            }
            let labels = Array<String>();
            labels.push(parameterName.copyBytes(
              0,
              parameterName.byteLength
            ));
            labels.push(parameterMode.copyBytes(
              0,
              parameterMode.byteLength
            ));
            labels.push(loweredTypeIdentity(resultType));
            labels.push(bodyKind.copyBytes(0, bodyKind.byteLength));
            for (const capture of captures) {
              labels.push(capture.name.copyBytes(
                0,
                capture.name.byteLength
              ));
              labels.push(loweredTypeIdentity(capture.type));
              const captureValue = pushExpression(
                inout output,
                LoweredExpressionKind.localValue,
                capture.name,
                Array<usize>(),
                Array<String>()
              );
              children.push(captureValue);
            }
            const mutexName = intrinsicMutexName(valueType);
            const lowered = pushExpression(
              inout output,
              LoweredExpressionKind.mutexWithLock,
              mutexName,
              children,
              labels
            );
            if (bodyKind == "block") {
              for (const sourceStatement of tree.nodes[closureInput].statements) {
                output[lowered].statements.push(sourceStatement);
              }
            }
            return lowered;
          }
        }
        none => {}
      }
    }
    if (
      tree.nodes[calleeInput].kind == ExpressionKind.memberExpression
      && tree.nodes[calleeInput].optionalAccess
    ) {
      const receiverInput = tree.nodes[calleeInput].children[0];
      if (!stableOptionalChainSource(tree, receiverInput)) {
        throw "native optional-chain method-call emission currently requires a named stable receiver; temporary receiver lowering remains deferred";
      }
      const receiverTypeName = match (evidenceResolvedExpressionTypeName(
        program,
        importedTypes,
        evidence,
        tree,
        receiverInput
      )) {
        some(name) => name;
        none => throw "native optional-chain method-call lowering could not resolve its receiver type";
      };
      if (!sourceTypeIsOption(receiverTypeName)) {
        throw `native optional-chain method-call lowering currently supports Option<T> receivers, found ${receiverTypeName}`;
      }
      let payloadTypeName = "";
      match (genericTypeShape(receiverTypeName)) {
        some(generic) => {
          payloadTypeName = generic.arguments[0].copyBytes(
            0,
            generic.arguments[0].byteLength
          );
        }
        none => match (intrinsicOptionPayloadName(receiverTypeName)) {
          some(payload) => payloadTypeName = move payload;
          none => {}
        }
      }
      if (
        payloadTypeName != "String"
        || tree.nodes[calleeInput].value != "byteAt"
        || tree.nodes[index].children.length != 2
      ) {
        throw "native optional-chain method-call lowering currently supports stable Option<String>?.byteAt(index); other methods remain Stage 0 authoritative";
      }
      const resultTypeName = match (evidenceResolvedExpressionTypeName(
        program,
        importedTypes,
        evidence,
        tree,
        index
      )) {
        some(name) => name;
        none => throw "native optional-chain method-call lowering could not resolve its result type";
      };
      const sourceType = try lowerModuleTypeName(
        program,
        importedTypes,
        receiverTypeName
      );
      const resultType = try lowerModuleTypeName(
        program,
        importedTypes,
        resultTypeName
      );
      const receiver = try lowerExpression(
        program,
        importedTypes,
        evidence,
        tree,
        receiverInput,
        inout output
      );
      const argumentInput = tree.nodes[index].children[1];
      const argument = try lowerExpression(
        program,
        importedTypes,
        evidence,
        tree,
        argumentInput,
        inout output
      );
      let children = Array<usize>();
      children.push(receiver);
      children.push(argument);
      let labels = Array<String>();
      labels.push(sourceType.name.copyBytes(
        0,
        sourceType.name.byteLength
      ));
      labels.push("String.byteAt");
      labels.push("wrap");
      return pushExpression(
        inout output,
        LoweredExpressionKind.optionalCallValue,
        resultType.name,
        children,
        labels
      );
    }
    if (
      tree.nodes[calleeInput].kind == ExpressionKind.identifierExpression
      && tree.nodes[index].children.length == 2
      && (
        tree.nodes[calleeInput].value == "i32"
        || tree.nodes[calleeInput].value == "u8"
        || tree.nodes[calleeInput].value == "u32"
        || tree.nodes[calleeInput].value == "u64"
        || tree.nodes[calleeInput].value == "usize"
      )
    ) {
      const argumentInput = tree.nodes[index].children[1];
      const argument = try lowerExpression(
        program,
        importedTypes,
        evidence,
        tree,
        argumentInput,
        inout output
      );
      let sourceType = "";
      match (resolvedExpressionTypeName(evidence, tree, argumentInput)) {
        some(name) => sourceType = move name;
        none => {
          if (
            output[argument].kind == LoweredExpressionKind.stringLength
            || output[argument].kind == LoweredExpressionKind.arrayLength
          ) sourceType = "usize";
        }
      }
      if (sourceType.byteLength == 0) {
        throw "native integer conversion could not resolve its source type";
      }
      const targetType = tree.nodes[calleeInput].value.copyBytes(
        0,
        tree.nodes[calleeInput].value.byteLength
      );
      const conversionSourceType = match (
        loweredIntegerSourceType(importedTypes, sourceType)
      ) {
        some(typeName) => typeName;
        none => throw `native integer conversion does not support source type ${sourceType} yet`;
      };
      let children = Array<usize>();
      children.push(argument);
      let labels = Array<String>();
      labels.push(conversionSourceType);
      return pushExpression(
        inout output,
        LoweredExpressionKind.integerConversion,
        targetType,
        children,
        labels
      );
    }
    if (
      tree.nodes[calleeInput].kind == ExpressionKind.identifierExpression
      && tree.nodes[index].children.length == 1
    ) {
      match (genericTypeShape(tree.nodes[calleeInput].value)) {
        some(generic) => {
          if (generic.base == "Array" && generic.arguments.length == 1) {
            const arrayType = try lowerModuleTypeName(
              program,
              importedTypes,
              tree.nodes[calleeInput].value
            );
            return pushExpression(
              inout output,
              LoweredExpressionKind.arrayEmpty,
              arrayType.name,
              Array<usize>(),
              Array<String>()
            );
          }
          if (generic.base == "Map" && generic.arguments.length == 2) {
            const mapType = try lowerModuleTypeName(
              program,
              importedTypes,
              tree.nodes[calleeInput].value
            );
            return pushExpression(
              inout output,
              LoweredExpressionKind.mapEmpty,
              mapType.name,
              Array<usize>(),
              Array<String>()
            );
          }
          if (generic.base == "Set" && generic.arguments.length == 1) {
            const setType = try lowerModuleTypeName(
              program,
              importedTypes,
              tree.nodes[calleeInput].value
            );
            return pushExpression(
              inout output,
              LoweredExpressionKind.setEmpty,
              setType.name,
              Array<usize>(),
              Array<String>()
            );
          }
        }
        none => {}
      }
    }
    if (
      tree.nodes[calleeInput].kind == ExpressionKind.identifierExpression
      && tree.nodes[calleeInput].value == "TextBuffer"
      && tree.nodes[index].children.length == 1
    ) {
      return pushExpression(
        inout output,
        LoweredExpressionKind.textBufferEmpty,
        "",
        Array<usize>(),
        Array<String>()
      );
    }
    if (
      tree.nodes[calleeInput].kind == ExpressionKind.memberExpression
      && tree.nodes[calleeInput].children.length == 1
    ) {
      const receiverInput = tree.nodes[calleeInput].children[0];
      if (
        tree.nodes[index].children.length == 2
        && (
          tree.nodes[calleeInput].value == "wrappingAdd"
          || tree.nodes[calleeInput].value == "wrappingSubtract"
          || tree.nodes[calleeInput].value == "wrappingMultiply"
        )
      ) {
        const receiverType = match (
          resolvedExpressionTypeName(evidence, tree, receiverInput)
        ) {
          some(name) => name;
          none => throw "native wrapping arithmetic could not resolve its receiver type";
        };
        if (
          receiverType == "i32"
          || receiverType == "u8"
          || receiverType == "u32"
          || receiverType == "u64"
          || receiverType == "usize"
        ) {
          const receiver = try lowerExpression(
            program,
            importedTypes,
            evidence,
            tree,
            receiverInput,
            inout output
          );
          const argumentInput = tree.nodes[index].children[1];
          const argument = try lowerExpression(
            program,
            importedTypes,
            evidence,
            tree,
            argumentInput,
            inout output
          );
          let children = Array<usize>();
          children.push(receiver);
          children.push(argument);
          if (tree.nodes[calleeInput].value == "wrappingAdd") {
            return pushExpression(
              inout output,
              LoweredExpressionKind.wrappingAddInteger,
              receiverType,
              children,
              Array<String>()
            );
          }
          if (tree.nodes[calleeInput].value == "wrappingSubtract") {
            return pushExpression(
              inout output,
              LoweredExpressionKind.wrappingSubtractInteger,
              receiverType,
              children,
              Array<String>()
            );
          }
          return pushExpression(
            inout output,
            LoweredExpressionKind.wrappingMultiplyInteger,
            receiverType,
            children,
            Array<String>()
          );
        }
      }
      if (
        tree.nodes[calleeInput].value == "byteAt"
        || tree.nodes[calleeInput].value == "copyBytes"
      ) {
        let labels = Array<String>();
        match (resolvedExpressionTypeName(evidence, tree, receiverInput)) {
          some(receiverTypeName) => {
            if (stringStartsWith(receiverTypeName, "view ")) {
              labels.push("view");
            }
          }
          none => {}
        }
        const receiver = try lowerExpression(
          program,
          importedTypes,
          evidence,
          tree,
          receiverInput,
          inout output
        );
        let children = Array<usize>();
        children.push(receiver);
        if (
          tree.nodes[calleeInput].value == "byteAt"
          && tree.nodes[index].children.length == 2
        ) {
          const positionInput = tree.nodes[index].children[1];
          const position = try lowerExpression(
            program,
            importedTypes,
            evidence,
            tree,
            positionInput,
            inout output
          );
          children.push(position);
          return pushExpression(
            inout output,
            LoweredExpressionKind.stringByteAt,
            "",
            children,
            labels
          );
        }
        if (
          tree.nodes[calleeInput].value == "copyBytes"
          && tree.nodes[index].children.length == 3
        ) {
          const startInput = tree.nodes[index].children[1];
          const start = try lowerExpression(
            program,
            importedTypes,
            evidence,
            tree,
            startInput,
            inout output
          );
          children.push(start);
          const endInput = tree.nodes[index].children[2];
          const end = try lowerExpression(
            program,
            importedTypes,
            evidence,
            tree,
            endInput,
            inout output
          );
          children.push(end);
          return pushExpression(
            inout output,
            LoweredExpressionKind.stringCopyBytes,
            "",
            children,
            labels
          );
        }
      }
    }
    if (
      tree.nodes[calleeInput].kind == ExpressionKind.memberExpression
      && tree.nodes[calleeInput].children.length == 1
      && (
        tree.nodes[calleeInput].value == "has"
        || tree.nodes[calleeInput].value == "add"
      )
    ) {
      const receiverInput = tree.nodes[calleeInput].children[0];
      match (resolvedExpressionTypeName(evidence, tree, receiverInput)) {
        some(receiverTypeName) => {
          const receiverType = try lowerModuleTypeName(
            program,
            importedTypes,
            receiverTypeName
          );
          if (receiverType.kind == LoweredTypeKind.setType) {
            const receiver = try lowerExpression(
              program,
              importedTypes,
              evidence,
              tree,
              receiverInput,
              inout output
            );
            const argumentInput = tree.nodes[index].children[1];
            const argument = try lowerExpression(
              program,
              importedTypes,
              evidence,
              tree,
              argumentInput,
              inout output
            );
            let children = Array<usize>();
            children.push(receiver);
            children.push(argument);
            const kind = tree.nodes[calleeInput].value == "add"
              ? LoweredExpressionKind.setAdd
              : LoweredExpressionKind.setHas;
            return pushExpression(
              inout output,
              kind,
              receiverType.name,
              children,
              Array<String>()
            );
          }
        }
        none => {}
      }
    }
    if (
      tree.nodes[calleeInput].kind == ExpressionKind.memberExpression
      && tree.nodes[calleeInput].children.length == 1
      && (
        tree.nodes[calleeInput].value == "has"
        || tree.nodes[calleeInput].value == "get"
        || tree.nodes[calleeInput].value == "set"
      )
    ) {
      const receiverInput = tree.nodes[calleeInput].children[0];
      match (resolvedExpressionTypeName(evidence, tree, receiverInput)) {
        some(receiverTypeName) => {
          const receiverType = try lowerModuleTypeName(
            program,
            importedTypes,
            receiverTypeName
          );
          if (receiverType.kind == LoweredTypeKind.mapType) {
            const receiver = try lowerExpression(
              program,
              importedTypes,
              evidence,
              tree,
              receiverInput,
              inout output
            );
            let children = Array<usize>();
            children.push(receiver);
            let argument: usize = 1;
            while (argument < tree.nodes[index].children.length) {
              const argumentInput = tree.nodes[index].children[argument];
              const value = try lowerExpression(
                program,
                importedTypes,
                evidence,
                tree,
                argumentInput,
                inout output
              );
              children.push(value);
              argument = argument + 1;
            }
            let kind = LoweredExpressionKind.mapHas;
            if (tree.nodes[calleeInput].value == "get") {
              kind = LoweredExpressionKind.mapGet;
            } else if (tree.nodes[calleeInput].value == "set") {
              kind = LoweredExpressionKind.mapSet;
            }
            return pushExpression(
              inout output,
              kind,
              receiverType.name,
              children,
              Array<String>()
            );
          }
        }
        none => {}
      }
    }
    if (
      tree.nodes[calleeInput].kind == ExpressionKind.memberExpression
      && tree.nodes[calleeInput].value == "push"
      && tree.nodes[calleeInput].children.length == 1
      && tree.nodes[index].children.length == 2
    ) {
      const receiverInput = tree.nodes[calleeInput].children[0];
      match (resolvedExpressionTypeName(evidence, tree, receiverInput)) {
        some(receiverTypeName) => {
          const receiverType = try lowerModuleTypeName(
            program,
            importedTypes,
            receiverTypeName
          );
          if (receiverType.kind == LoweredTypeKind.arrayType) {
            const receiver = try lowerExpression(
              program,
              importedTypes,
              evidence,
              tree,
              receiverInput,
              inout output
            );
            markMutableStorage(inout output, receiver);
            const argumentInput = tree.nodes[index].children[1];
            const argument = try lowerExpression(
              program,
              importedTypes,
              evidence,
              tree,
              argumentInput,
              inout output
            );
            let moveChildren = Array<usize>();
            moveChildren.push(argument);
            const movedArgument = pushExpression(
              inout output,
              LoweredExpressionKind.moveValue,
              "",
              moveChildren,
              Array<String>()
            );
            let children = Array<usize>();
            children.push(receiver);
            children.push(movedArgument);
            return pushExpression(
              inout output,
              LoweredExpressionKind.arrayPush,
              receiverType.name,
              children,
              Array<String>()
            );
          }
          if (
            receiverType.kind == LoweredTypeKind.mapType
            && tree.nodes[index].value == "length"
          ) {
            const receiver = try lowerExpression(
              program,
              importedTypes,
              evidence,
              tree,
              receiverInput,
              inout output
            );
            let children = Array<usize>();
            children.push(receiver);
            return pushExpression(
              inout output,
              LoweredExpressionKind.mapLength,
              receiverType.name,
              children,
              Array<String>()
            );
          }
          if (
            receiverType.kind == LoweredTypeKind.setType
            && tree.nodes[index].value == "length"
          ) {
            const receiver = try lowerExpression(
              program,
              importedTypes,
              evidence,
              tree,
              receiverInput,
              inout output
            );
            let children = Array<usize>();
            children.push(receiver);
            return pushExpression(
              inout output,
              LoweredExpressionKind.setLength,
              receiverType.name,
              children,
              Array<String>()
            );
          }
        }
        none => {}
      }
    }
    if (
      tree.nodes[calleeInput].kind == ExpressionKind.memberExpression
      && tree.nodes[calleeInput].value == "unlock"
      && tree.nodes[calleeInput].children.length == 1
      && tree.nodes[index].children.length == 1
    ) {
      const receiverInput = tree.nodes[calleeInput].children[0];
      match (resolvedExpressionTypeName(evidence, tree, receiverInput)) {
        some(receiverTypeName) => {
          const receiverType = try lowerModuleTypeName(
            program,
            importedTypes,
            receiverTypeName
          );
          if (receiverType.kind == LoweredTypeKind.fsLockType) {
            const receiver = try lowerExpression(
              program,
              importedTypes,
              evidence,
              tree,
              receiverInput,
              inout output
            );
            let moveChildren = Array<usize>();
            moveChildren.push(receiver);
            const movedReceiver = pushExpression(
              inout output,
              LoweredExpressionKind.moveValue,
              "",
              moveChildren,
              Array<String>()
            );
            let children = Array<usize>();
            children.push(movedReceiver);
            return pushExpression(
              inout output,
              LoweredExpressionKind.fsLockUnlock,
              "",
              move children,
              Array<String>()
            );
          }
        }
        none => {}
      }
    }
    if (
      tree.nodes[calleeInput].kind == ExpressionKind.memberExpression
      && tree.nodes[calleeInput].children.length == 1
      && (
        tree.nodes[calleeInput].value == "append"
        || tree.nodes[calleeInput].value == "appendBytes"
        || tree.nodes[calleeInput].value == "appendAscii"
        || tree.nodes[calleeInput].value == "finish"
      )
    ) {
      const receiverInput = tree.nodes[calleeInput].children[0];
      const receiver = try lowerExpression(
        program,
        importedTypes,
        evidence,
        tree,
        receiverInput,
        inout output
      );
      let children = Array<usize>();
      children.push(receiver);
      let argument: usize = 1;
      while (argument < tree.nodes[index].children.length) {
        const argumentInput = tree.nodes[index].children[argument];
        const value = try lowerExpression(
          program,
          importedTypes,
          evidence,
          tree,
          argumentInput,
          inout output
        );
        children.push(value);
        argument = argument + 1;
      }
      if (tree.nodes[calleeInput].value == "finish") {
        return pushExpression(
          inout output,
          LoweredExpressionKind.moveValue,
          "",
          children,
          Array<String>()
        );
      }
      let kind = LoweredExpressionKind.textBufferAppend;
      if (tree.nodes[calleeInput].value == "appendBytes") {
        kind = LoweredExpressionKind.textBufferAppendBytes;
      } else if (tree.nodes[calleeInput].value == "appendAscii") {
        kind = LoweredExpressionKind.textBufferAppendAscii;
      }
      return pushExpression(
        inout output,
        kind,
        "",
        children,
        Array<String>()
      );
    }
    if (
      tree.nodes[calleeInput].kind == ExpressionKind.memberExpression
      && tree.nodes[calleeInput].children.length == 1
    ) {
      const enumInput = tree.nodes[calleeInput].children[0];
      if (tree.nodes[enumInput].kind == ExpressionKind.identifierExpression) {
        const intrinsicName = contextualIntrinsicTypeName(
          evidence,
          tree,
          index,
          tree.nodes[enumInput].value
        );
        const intrinsic = try intrinsicOptionDeclaration(
          program,
          importedTypes,
          intrinsicName
        );
        match (in intrinsic) {
          some(declaration) => {
            for (const variant of declaration.variants) {
              if (variant.name == tree.nodes[calleeInput].value) {
                match (in variant.payload) {
                  some(_) => {
                    if (tree.nodes[index].children.length != 2) {
                      throw `native enum payload construction for ${tree.nodes[enumInput].value}.${variant.name} requires one value`;
                    }
                    const payloadInput = tree.nodes[index].children[1];
                    let payload = try lowerExpression(
                      program,
                      importedTypes,
                      evidence,
                      tree,
                      payloadInput,
                      inout output
                    );
                    payload = wrapImplicitOwnedTransfer(
                      tree,
                      payloadInput,
                      payload,
                      inout output
                    );
                    let children = Array<usize>();
                    children.push(payload);
                    let labels = Array<String>();
                    labels.push(variant.name.copyBytes(0, variant.name.byteLength));
                    return pushExpression(
                      inout output,
                      LoweredExpressionKind.enumPayloadValue,
                      declaration.name,
                      children,
                      labels
                    );
                  }
                  none => {}
                }
              }
            }
          }
          none => {}
        }
        match (enumIndex(program, tree.nodes[enumInput].value)) {
          some(declarationIndex) => {
            for (const variant of program.enums[declarationIndex].variants) {
              if (variant.name == tree.nodes[calleeInput].value) {
                match (in variant.payload) {
                  some(_) => {
                    if (tree.nodes[index].children.length != 2) {
                      throw `native enum payload construction for ${tree.nodes[enumInput].value}.${variant.name} requires one value`;
                    }
                    const payloadInput = tree.nodes[index].children[1];
                    let payload = try lowerExpression(
                      program,
                      importedTypes,
                      evidence,
                      tree,
                      payloadInput,
                      inout output
                    );
                    payload = wrapImplicitOwnedTransfer(
                      tree,
                      payloadInput,
                      payload,
                      inout output
                    );
                    let children = Array<usize>();
                    children.push(payload);
                    let labels = Array<String>();
                    labels.push(variant.name.copyBytes(0, variant.name.byteLength));
                    const enumType = try lowerModuleTypeName(
                      program,
                      importedTypes,
                      tree.nodes[enumInput].value
                    );
                    return pushExpression(
                      inout output,
                      LoweredExpressionKind.enumPayloadValue,
                      enumType.name,
                      children,
                      labels
                    );
                  }
                  none => {}
                }
              }
            }
          }
          none => {}
        }
        match (importedEnumDeclaration(
          importedTypes,
          tree.nodes[enumInput].value
        )) {
          some(declaration) => {
            for (const variant of declaration.variants) {
              if (variant.name != tree.nodes[calleeInput].value) continue;
              match (in variant.payload) {
                some(_) => {
                  if (tree.nodes[index].children.length != 2) {
                    throw `native enum payload construction for ${tree.nodes[enumInput].value}.${variant.name} requires one value`;
                  }
                  const payloadInput = tree.nodes[index].children[1];
                  let payload = try lowerExpression(
                    program,
                    importedTypes,
                    evidence,
                    tree,
                    payloadInput,
                    inout output
                  );
                  payload = wrapImplicitOwnedTransfer(
                    tree,
                    payloadInput,
                    payload,
                    inout output
                  );
                  let children = Array<usize>();
                  children.push(payload);
                  let labels = Array<String>();
                  labels.push(variant.name.copyBytes(0, variant.name.byteLength));
                  return pushExpression(
                    inout output,
                    LoweredExpressionKind.enumPayloadValue,
                    declaration.name,
                    children,
                    labels
                  );
                }
                none => {}
              }
            }
          }
          none => {}
        }
      }
    }
    if (
      tree.nodes[calleeInput].kind == ExpressionKind.identifierExpression
      && (
        tree.nodes[index].children.length == 1
        || tree.nodes[index].children.length == 2
      )
    ) {
      let constructionName = "";
      let localAggregate = Option<usize>.none;
      match (structIndex(program, tree.nodes[calleeInput].value)) {
        some(aggregateIndex) => {
          localAggregate = Option.some(aggregateIndex);
        }
        none => {}
      }
      match (importedStructTarget(
        importedTypes,
        tree.nodes[calleeInput].value
      )) {
        some(name) => constructionName = move name;
        none => match (in localAggregate) {
          some(_) => {
            constructionName = tree.nodes[calleeInput].value.copyBytes(
              0,
              tree.nodes[calleeInput].value.byteLength
            );
          }
          none => {}
        }
      }
      let localConstruction = false;
      match (in localAggregate) {
        some(_) => localConstruction = true;
        none => {}
      }
      if (
        constructionName.byteLength > 0
        && (tree.nodes[index].children.length == 2 || localConstruction)
      ) {
        let children = Array<usize>();
        let labels = Array<String>();
        let hasSpread = false;
        let spreadMode = "";
        let spreadSourceInput: usize = 0;
        let spreadSource: usize = 0;
        if (tree.nodes[index].children.length == 2) {
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
          hasSpread = tree.nodes[objectInput].labels.length > 0
            && tree.nodes[objectInput].labels[0] == "...";
          if (hasSpread) {
            match (in localAggregate) {
              some(_) => {}
              none => throw "native struct-spread lowering requires a local Z value struct";
            }
            const spreadInput = tree.nodes[objectInput].children[0];
            spreadSourceInput = spreadInput;
            if (
              tree.nodes[spreadInput].kind == ExpressionKind.unaryExpression
            ) {
              spreadMode = tree.nodes[spreadInput].value.copyBytes(
                0,
                tree.nodes[spreadInput].value.byteLength
              );
              if (
                (spreadMode != "copy" && spreadMode != "move")
                || tree.nodes[spreadInput].children.length != 1
              ) {
                throw "native struct-spread lowering received an unsupported capability";
              }
              spreadSourceInput = tree.nodes[spreadInput].children[0];
            }
            if (
              tree.nodes[spreadSourceInput].kind
                != ExpressionKind.identifierExpression
            ) {
              throw "native struct-spread lowering requires a named source";
            }
            spreadSource = try lowerExpression(
              program,
              importedTypes,
              evidence,
              tree,
              spreadSourceInput,
              inout output
            );
          }
          let field: usize = hasSpread ? usize(1) : usize(0);
          while (field < tree.nodes[objectInput].children.length) {
            const valueInput = tree.nodes[objectInput].children[field];
            const fieldName = tree.nodes[objectInput].labels[field].copyBytes(
              0,
              tree.nodes[objectInput].labels[field].byteLength
            );
            let expectedTypeName = "";
            match (fieldTypeNameForOwner(
              program,
              importedTypes,
              constructionName,
              fieldName
            )) {
              some(name) => expectedTypeName = move name;
              none => {}
            }
            let value: usize = 0;
            if (expectedTypeName.byteLength > 0) {
              if (fieldIsOptionalForOwner(
                program,
                importedTypes,
                constructionName,
                fieldName
              )) {
                value = try lowerOptionalFieldExpression(
                  program,
                  importedTypes,
                  evidence,
                  tree,
                  valueInput,
                  expectedTypeName,
                  inout output
                );
              } else {
                value = try lowerExpressionExpected(
                  program,
                  importedTypes,
                  evidence,
                  tree,
                  valueInput,
                  expectedTypeName,
                  inout output
                );
              }
            } else {
              value = try lowerExpression(
                program,
                importedTypes,
                evidence,
                tree,
                valueInput,
                inout output
              );
            }
            value = wrapImplicitOwnedTransfer(
              tree,
              valueInput,
              value,
              inout output
            );
            children.push(value);
            labels.push(fieldName.copyBytes(
              0,
              fieldName.byteLength
            ));
            field = field + 1;
          }
        }
        match (in localAggregate) {
          some(aggregateIndex) => {
            let attachedMove = false;
            for (const field of program.aggregates[aggregateIndex].fields) {
              if (containsString(labels, field.name)) {
                if (hasSpread && spreadMode == "move") {
                  const overriddenType = try lowerModuleType(
                    program,
                    importedTypes,
                    field.type
                  );
                  if (moduleTypeNeedsCleanup(
                    program,
                    importedTypes,
                    overriddenType
                  )) {
                    throw `native move struct-spread lowering cannot clean an overridden ownership-bearing field "${field.name}" yet`;
                  }
                }
                continue;
              }
              if (hasSpread) {
                const fieldType = try lowerModuleType(
                  program,
                  importedTypes,
                  field.type
                );
                let source = spreadSource;
                if (spreadMode == "move" && !attachedMove) {
                  let moveChildren = Array<usize>();
                  moveChildren.push(source);
                  source = pushExpression(
                    inout output,
                    LoweredExpressionKind.moveValue,
                    "",
                    moveChildren,
                    Array<String>()
                  );
                  attachedMove = true;
                }
                let fieldChildren = Array<usize>();
                fieldChildren.push(source);
                let value = pushExpression(
                  inout output,
                  LoweredExpressionKind.fieldValue,
                  field.name,
                  fieldChildren,
                  Array<String>()
                );
                if (spreadMode == "copy") {
                  if (fieldType.kind == LoweredTypeKind.stringType) {
                    let copyChildren = Array<usize>();
                    copyChildren.push(value);
                    value = pushExpression(
                      inout output,
                      LoweredExpressionKind.copyValue,
                      "",
                      copyChildren,
                      Array<String>()
                    );
                  } else if (moduleTypeNeedsCleanup(
                    program,
                    importedTypes,
                    fieldType
                  )) {
                    throw `native copy struct-spread lowering does not support field "${field.name}" of type ${field.type.name} yet`;
                  }
                } else if (
                  spreadMode.byteLength == 0
                  && moduleTypeNeedsCleanup(
                    program,
                    importedTypes,
                    fieldType
                  )
                ) {
                  throw `native plain struct-spread lowering cannot retain ownership-bearing field "${field.name}"`;
                }
                children.push(value);
                labels.push(field.name.copyBytes(
                  0,
                  field.name.byteLength
                ));
                continue;
              }
              match (in field.defaultValue) {
                some(defaultSyntax) => match (in defaultSyntax.tree) {
                  some(defaultTree) => {
                    const defaultRoot = defaultTree.root;
                    let value = try lowerExpressionExpected(
                      program,
                      importedTypes,
                      evidence,
                      defaultTree,
                      defaultRoot,
                      field.type.name,
                      inout output
                    );
                    value = wrapImplicitOwnedTransfer(
                      defaultTree,
                      defaultRoot,
                      value,
                      inout output
                    );
                    children.push(value);
                    labels.push(field.name.copyBytes(
                      0,
                      field.name.byteLength
                    ));
                  }
                  none => throw `native lowering could not project default value for ${constructionName}.${field.name}`;
                }
                none => {
                  if (field.optionalField) {
                    const value = try lowerOptionalFieldNone(
                      program,
                      importedTypes,
                      field.type.name,
                      inout output
                    );
                    children.push(value);
                    labels.push(field.name.copyBytes(
                      0,
                      field.name.byteLength
                    ));
                  }
                }
              }
            }
            if (hasSpread && spreadMode == "move" && !attachedMove) {
              throw "native move struct-spread lowering requires at least one retained field";
            }
          }
          none => {}
        }
        if (!localConstruction) {
          for (const imported of importedTypes) {
            if (
              imported.localName != constructionName
              && imported.targetName != constructionName
            ) continue;
            for (const field of imported.fields) {
              if (
                !field.optionalField
                || containsString(labels, field.name)
              ) continue;
              const optionalTypeName = loweredTypeIdentity(field.type);
              const value = try lowerOptionalFieldNone(
                program,
                importedTypes,
                optionalTypeName,
                inout output
              );
              children.push(value);
              labels.push(field.name.copyBytes(
                0,
                field.name.byteLength
              ));
            }
          }
        }
        return pushExpression(
          inout output,
          LoweredExpressionKind.structValue,
          constructionName,
          children,
          labels
        );
      }
    }
    if (
      resolvedCallKind(evidence, tree, index) == "method"
      && tree.nodes[calleeInput].kind == ExpressionKind.memberExpression
      && tree.nodes[calleeInput].children.length == 1
    ) {
      const receiverInput = tree.nodes[calleeInput].children[0];
      const receiverTypeName = match (evidenceResolvedExpressionTypeName(
        program,
        importedTypes,
        evidence,
        tree,
        receiverInput
      )) {
        some(name) => name;
        none => throw "native method-call lowering could not resolve its receiver type";
      };
      const receiverType = try lowerModuleTypeName(
        program,
        importedTypes,
        receiverTypeName
      );
      if (
        receiverType.kind != LoweredTypeKind.structType
        && receiverType.kind != LoweredTypeKind.classType
      ) {
        throw `native method-call lowering requires a concrete struct or class receiver, found ${receiverTypeName}`;
      }
      const receiverMode = resolvedCallReceiverMode(
        evidence,
        tree,
        index
      );
      if (receiverMode == "move") {
        throw "native method-call lowering does not support consuming receivers yet";
      }
      const receiver = try lowerExpression(
        program,
        importedTypes,
        evidence,
        tree,
        receiverInput,
        inout output
      );
      let children = Array<usize>();
      children.push(receiver);
      const parameterModes = resolvedCallParameterModes(
        program,
        evidence,
        tree,
        index
      );
      let labels = Array<String>();
      labels.push(receiverType.kind == LoweredTypeKind.classType
        ? "class"
        : "struct");
      if (receiverMode.byteLength > 0) {
        labels.push(receiverMode.copyBytes(0, receiverMode.byteLength));
      } else labels.push("in");
      let argument: usize = 1;
      while (argument < tree.nodes[index].children.length) {
        const argumentInput = tree.nodes[index].children[argument];
        let value = try lowerExpression(
          program,
          importedTypes,
          evidence,
          tree,
          argumentInput,
          inout output
        );
        if (
          parameterModes.length >= argument
          && parameterModes[argument - 1] == "value"
        ) value = wrapImplicitOwnedTransfer(
          tree,
          argumentInput,
          value,
          inout output
        );
        if (
          parameterModes.length >= argument
          && (
            parameterModes[argument - 1] == "inout"
            || parameterModes[argument - 1] == "out"
          )
        ) markMutableStorage(inout output, value);
        children.push(value);
        labels.push(parameterModes.length >= argument
          ? parameterModes[argument - 1].copyBytes(
            0,
            parameterModes[argument - 1].byteLength
          )
          : "value");
        argument = argument + 1;
      }
      return pushExpression(
        inout output,
        LoweredExpressionKind.methodCall,
        `Z_${receiverType.name}_${tree.nodes[calleeInput].value}`,
        children,
        labels
      );
    }
    let callee: usize = 0;
    let standardTarget = "";
    let foreignTarget = "";
    match (resolvedCallTarget(evidence, tree, index)) {
      some(target) => {
        if (
          target == "sleep"
          && tree.nodes[calleeInput].kind
            == ExpressionKind.identifierExpression
          && isImportedStandardBinding(
            program,
            "std/time",
            "sleep",
            tree.nodes[calleeInput].value
          )
        ) standardTarget = "time.sleep";
        else if (
          target == "fs.lock"
          || target == "fs.readBytes"
          || target == "fs.readText"
          || target == "fs.writeText"
          || target == "fs.replace"
          || target == "fs.exists"
          || target == "fs.isDirectory"
          || target == "fs.createDirectories"
          || target == "fs.realPath"
          || target == "process.args"
          || target == "process.executablePath"
          || target == "process.run"
          || target == "console.log"
          || target == "console.write"
          || target == "console.error"
          || target == "console.debug"
        ) standardTarget = move target;
      }
      none => {}
    }
    if (
      standardTarget.byteLength == 0
      && tree.nodes[calleeInput].kind == ExpressionKind.identifierExpression
      && isImportedStandardBinding(
        program,
        "std/time",
        "sleep",
        tree.nodes[calleeInput].value
      )
    ) standardTarget = "time.sleep";
    match (resolvedForeignCallTarget(evidence, tree, index)) {
      some(target) => foreignTarget = move target;
      none => {}
    }
    if (standardTarget.byteLength > 0) {
      callee = pushExpression(
        inout output,
        LoweredExpressionKind.localValue,
        standardTarget,
        Array<usize>(),
        Array<String>()
      );
    } else if (foreignTarget.byteLength > 0) {
      callee = pushExpression(
        inout output,
        LoweredExpressionKind.localValue,
        foreignTarget,
        Array<usize>(),
        Array<String>()
      );
    } else if (
      tree.nodes[calleeInput].kind == ExpressionKind.identifierExpression
    ) {
      match (resolvedCallTarget(evidence, tree, index)) {
        some(target) => callee = pushExpression(
          inout output,
          LoweredExpressionKind.localValue,
          target,
          Array<usize>(),
          Array<String>()
        );
        none => match (importedCallTarget(
          program,
          tree.nodes[calleeInput].value
        )) {
          some(target) => callee = pushExpression(
            inout output,
            LoweredExpressionKind.localValue,
            target,
            Array<usize>(),
            Array<String>()
          );
          none => callee = try lowerExpression(
            program,
            importedTypes,
            evidence,
            tree,
            calleeInput,
            inout output
          );
        }
      }
    } else {
      callee = try lowerExpression(
        program,
        importedTypes,
        evidence,
        tree,
        calleeInput,
        inout output
      );
    }
    const parameterModes = resolvedCallParameterModes(
      program,
      evidence,
      tree,
      index
    );
    let callLabels = Array<String>();
    for (const mode of parameterModes) {
      callLabels.push(mode.copyBytes(0, mode.byteLength));
    }
    let children = Array<usize>();
    children.push(callee);
    let argument: usize = 1;
    while (argument < tree.nodes[index].children.length) {
      const argumentInput = tree.nodes[index].children[argument];
      let value = try lowerExpression(
        program,
        importedTypes,
        evidence,
        tree,
        argumentInput,
        inout output
      );
      if (
        parameterModes.length >= argument
        && parameterModes[argument - 1] == "value"
      ) {
        value = wrapImplicitOwnedTransfer(
          tree,
          argumentInput,
          value,
          inout output
        );
      }
      if (
        parameterModes.length >= argument
        && (
          parameterModes[argument - 1] == "inout"
          || parameterModes[argument - 1] == "out"
        )
      ) markMutableStorage(inout output, value);
      if (
        parameterModes.length >= argument
        && parameterModes[argument - 1] == "in"
        && tree.nodes[argumentInput].kind
          == ExpressionKind.templateExpression
      ) {
        let temporaryChildren = Array<usize>();
        temporaryChildren.push(value);
        value = pushExpression(
          inout output,
          LoweredExpressionKind.borrowedTemporary,
          "String",
          temporaryChildren,
          Array<String>()
        );
      }
      if (
        callLabels.length >= argument
        && callLabels[argument - 1] == "in"
      ) {
        match (evidenceResolvedExpressionTypeName(
          program,
          importedTypes,
          evidence,
          tree,
          argumentInput
        )) {
          some(argumentType) => {
            if (stringStartsWith(argumentType, "view ")) {
              callLabels[argument - 1] = "view";
            }
          }
          none => {}
        }
      }
      children.push(value);
      argument = argument + 1;
    }
    return pushExpression(
      inout output,
      LoweredExpressionKind.directCall,
      "",
      children,
      callLabels
    );
  }
  if (tree.nodes[index].kind == ExpressionKind.indexExpression) {
    if (tree.nodes[index].children.length != 2) {
      throw "native lowering received a malformed index expression";
    }
    const receiverInput = tree.nodes[index].children[0];
    const receiverTypeName = match (evidenceResolvedExpressionTypeName(
      program,
      importedTypes,
      evidence,
      tree,
      receiverInput
    )) {
      some(name) => name;
      none => throw `native lowering could not resolve indexed storage at ${tree.nodes[receiverInput].line}:${tree.nodes[receiverInput].column}`;
    };
    let receiverValueTypeName = receiverTypeName.copyBytes(
      0,
      receiverTypeName.byteLength
    );
    let receiverView = false;
    if (
      stringStartsWith(receiverValueTypeName, "view ")
      && receiverValueTypeName.byteLength > 5
    ) {
      receiverValueTypeName = receiverValueTypeName.copyBytes(
        5,
        receiverValueTypeName.byteLength
      );
      receiverView = true;
    }
    const receiverType = try lowerModuleTypeName(
      program,
      importedTypes,
      receiverValueTypeName
    );
    if (receiverType.kind != LoweredTypeKind.arrayType) {
      throw `native lowering does not support indexing ${receiverTypeName} yet`;
    }
    const receiver = try lowerExpression(
      program,
      importedTypes,
      evidence,
      tree,
      receiverInput,
      inout output
    );
    const offsetInput = tree.nodes[index].children[1];
    const offset = try lowerExpression(
      program,
      importedTypes,
      evidence,
      tree,
      offsetInput,
      inout output
    );
    let children = Array<usize>();
    children.push(receiver);
    children.push(offset);
    let labels = Array<String>();
    if (receiverView) labels.push("view");
    return pushExpression(
      inout output,
      LoweredExpressionKind.arrayIndex,
      receiverType.name,
      children,
      labels
    );
  }
  if (tree.nodes[index].kind == ExpressionKind.memberExpression) {
    if (tree.nodes[index].children.length != 1) {
      throw "native lowering received a malformed member expression";
    }
    const receiverInput = tree.nodes[index].children[0];
    if (tree.nodes[index].optionalAccess) {
      if (!stableOptionalChainSource(tree, receiverInput)) {
        throw "native optional-chain emission currently requires a named stable receiver; temporary receiver lowering remains deferred";
      }
      const receiverTypeName = match (evidenceResolvedExpressionTypeName(
        program,
        importedTypes,
        evidence,
        tree,
        receiverInput
      )) {
        some(name) => name;
        none => throw "native optional-chain lowering could not resolve its receiver type";
      };
      if (!sourceTypeIsOption(receiverTypeName)) {
        throw `native optional-chain lowering currently supports Option<T> receivers, found ${receiverTypeName}`;
      }
      let payloadTypeName = "";
      match (genericTypeShape(receiverTypeName)) {
        some(generic) => {
          payloadTypeName = generic.arguments[0].copyBytes(
            0,
            generic.arguments[0].byteLength
          );
        }
        none => match (intrinsicOptionPayloadName(receiverTypeName)) {
          some(payload) => payloadTypeName = move payload;
          none => {}
        }
      }
      if (payloadTypeName.byteLength == 0) {
        throw `native optional-chain lowering could not resolve ${receiverTypeName}`;
      }
      const fieldTypeName = match (fieldTypeNameForOwner(
        program,
        importedTypes,
        payloadTypeName,
        tree.nodes[index].value
      )) {
        some(name) => name;
        none => throw `native optional-chain lowering could not resolve ${payloadTypeName}.${tree.nodes[index].value}`;
      };
      const resultTypeName = match (evidenceResolvedExpressionTypeName(
        program,
        importedTypes,
        evidence,
        tree,
        index
      )) {
        some(name) => name;
        none => throw "native optional-chain lowering could not resolve its result type";
      };
      match (genericTypeShape(resultTypeName)) {
        some(result) => {
          if (
            result.base == "Option"
            && result.arguments.length == 1
            && stringStartsWith(result.arguments[0], "view ")
          ) {
            throw "native optional-chain cleanup-bearing view projection remains deferred";
          }
        }
        none => {}
      }
      const receiverType = try lowerModuleTypeName(
        program,
        importedTypes,
        receiverTypeName
      );
      const resultType = try lowerModuleTypeName(
        program,
        importedTypes,
        resultTypeName
      );
      const receiver = try lowerExpression(
        program,
        importedTypes,
        evidence,
        tree,
        receiverInput,
        inout output
      );
      let children = Array<usize>();
      children.push(receiver);
      let labels = Array<String>();
      labels.push(receiverType.name.copyBytes(
        0,
        receiverType.name.byteLength
      ));
      labels.push(tree.nodes[index].value.copyBytes(
        0,
        tree.nodes[index].value.byteLength
      ));
      labels.push(sourceTypeIsOption(fieldTypeName) ? "flatten" : "wrap");
      return pushExpression(
        inout output,
        LoweredExpressionKind.optionalFieldValue,
        resultType.name,
        children,
        labels
      );
    }
    if (tree.nodes[index].value == "length") {
      match (resolvedExpressionTypeName(evidence, tree, receiverInput)) {
        some(receiverTypeName) => {
          let receiverValueTypeName = receiverTypeName.copyBytes(
            0,
            receiverTypeName.byteLength
          );
          let receiverView = false;
          if (
            stringStartsWith(receiverValueTypeName, "view ")
            && receiverValueTypeName.byteLength > 5
          ) {
            receiverValueTypeName = receiverValueTypeName.copyBytes(
              5,
              receiverValueTypeName.byteLength
            );
            receiverView = true;
          }
          const receiverType = try lowerModuleTypeName(
            program,
            importedTypes,
            receiverValueTypeName
          );
          if (receiverType.kind == LoweredTypeKind.arrayType) {
            const receiver = try lowerExpression(
              program,
              importedTypes,
              evidence,
              tree,
              receiverInput,
              inout output
            );
            let children = Array<usize>();
            children.push(receiver);
            let labels = Array<String>();
            if (receiverView) labels.push("view");
            return pushExpression(
              inout output,
              LoweredExpressionKind.arrayLength,
              receiverType.name,
              children,
              labels
            );
          }
        }
        none => {}
      }
    }
    if (
      tree.nodes[index].value == "byteLength"
      || tree.nodes[index].value == "isEmpty"
    ) {
      let labels = Array<String>();
      match (resolvedExpressionTypeName(evidence, tree, receiverInput)) {
        some(receiverTypeName) => {
          if (stringStartsWith(receiverTypeName, "view ")) {
            labels.push("view");
          }
        }
        none => {}
      }
      const receiver = try lowerExpression(
        program,
        importedTypes,
        evidence,
        tree,
        receiverInput,
        inout output
      );
      let children = Array<usize>();
      children.push(receiver);
      if (tree.nodes[index].value == "byteLength") {
        return pushExpression(
          inout output,
          LoweredExpressionKind.stringLength,
          "",
          children,
          labels
        );
      }
      if (tree.nodes[index].value == "isEmpty") {
        return pushExpression(
          inout output,
          LoweredExpressionKind.stringIsEmpty,
          "",
          children,
          labels
        );
      }
    }
    if (tree.nodes[receiverInput].kind == ExpressionKind.identifierExpression) {
      const intrinsicName = contextualIntrinsicTypeName(
        evidence,
        tree,
        index,
        tree.nodes[receiverInput].value
      );
      const intrinsic = try intrinsicOptionDeclaration(
        program,
        importedTypes,
        intrinsicName
      );
      match (in intrinsic) {
        some(declaration) => {
          for (const variant of declaration.variants) {
            if (variant.name == tree.nodes[index].value) {
              match (in variant.payload) {
                some(_) => throw `native lowering does not support payload enum variant ${tree.nodes[receiverInput].value}.${variant.name} without a value`;
                none => {}
              }
              let labels = Array<String>();
              labels.push(variant.name.copyBytes(0, variant.name.byteLength));
              labels.push("tagged");
              return pushExpression(
                inout output,
                LoweredExpressionKind.enumValue,
                declaration.name,
                Array<usize>(),
                labels
              );
            }
          }
        }
        none => {}
      }
      match (enumIndex(program, tree.nodes[receiverInput].value)) {
        some(declarationIndex) => {
          for (const variant of program.enums[declarationIndex].variants) {
            if (variant.name == tree.nodes[index].value) {
              match (in variant.payload) {
                some(_) => throw `native lowering does not support payload enum variant ${tree.nodes[receiverInput].value}.${variant.name} yet`;
                none => {}
              }
              let labels = Array<String>();
              labels.push(variant.name.copyBytes(0, variant.name.byteLength));
              if (enumHasPayload(program, declarationIndex)) {
                labels.push("tagged");
              }
              const enumType = try lowerModuleTypeName(
                program,
                importedTypes,
                tree.nodes[receiverInput].value
              );
              return pushExpression(
                inout output,
                LoweredExpressionKind.enumValue,
                enumType.name,
                Array<usize>(),
                labels
              );
            }
          }
        }
        none => {}
      }
      match (importedEnumDeclaration(
        importedTypes,
        tree.nodes[receiverInput].value
      )) {
        some(declaration) => {
          for (const variant of declaration.variants) {
            if (variant.name != tree.nodes[index].value) continue;
            match (in variant.payload) {
              some(_) => throw `native lowering does not support payload enum variant ${tree.nodes[receiverInput].value}.${variant.name} without a value`;
              none => {}
            }
            let labels = Array<String>();
            labels.push(variant.name.copyBytes(0, variant.name.byteLength));
            if (declaration.payloadBearing) labels.push("tagged");
            return pushExpression(
              inout output,
              LoweredExpressionKind.enumValue,
              declaration.name,
              Array<usize>(),
              labels
            );
          }
        }
        none => {}
      }
    }
    const receiver = try lowerExpression(
      program,
      importedTypes,
      evidence,
      tree,
      receiverInput,
      inout output
    );
    let children = Array<usize>();
    children.push(receiver);
    let labels = Array<String>();
    match (resolvedExpressionTypeName(evidence, tree, receiverInput)) {
      some(receiverType) => {
        if (stringStartsWith(receiverType, "view ")) labels.push("view");
        else {
          const loweredReceiver = attempt lowerModuleTypeName(
            program,
            importedTypes,
            receiverType
          );
          match (loweredReceiver) {
            success(type) => {
              if (type.kind == LoweredTypeKind.classType) {
                labels.push("class");
              }
            }
            failure(_) => {}
          }
        }
      }
      none => {}
    }
    return pushExpression(
      inout output,
      LoweredExpressionKind.fieldValue,
      tree.nodes[index].value,
      children,
      labels
    );
  }
  const unsupportedKind = expressionKindName(tree.nodes[index].kind);
  throw `native lowering does not support ${unsupportedKind} expression at ${tree.nodes[index].line}:${tree.nodes[index].column} yet`;
}

function lowerExpressionExpected(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize,
  in expectedTypeName: String,
  inout output: Array<LoweredExpression>
): usize throws String {
  match (genericTypeShape(expectedTypeName)) {
    some(generic) => {
      if (
        generic.base == "Mutex"
        && generic.arguments.length == 1
        && tree.nodes[index].kind == ExpressionKind.callExpression
        && tree.nodes[index].children.length == 2
      ) {
        const callee = tree.nodes[index].children[0];
        if (tree.nodes[callee].kind == ExpressionKind.identifierExpression) {
          let bindingName = tree.nodes[callee].value.copyBytes(
            0,
            tree.nodes[callee].value.byteLength
          );
          match (genericTypeShape(bindingName)) {
            some(calleeType) => bindingName = calleeType.base.copyBytes(
              0,
              calleeType.base.byteLength
            );
            none => {}
          }
          if (isImportedStandardBinding(
            program,
            "std/sync",
            "Mutex",
            bindingName
          )) {
            const valueType = try lowerModuleTypeName(
              program,
              importedTypes,
              generic.arguments[0]
            );
            const valueInput = tree.nodes[index].children[1];
            let value = try lowerExpressionExpected(
              program,
              importedTypes,
              evidence,
              tree,
              valueInput,
              generic.arguments[0],
              inout output
            );
            value = wrapImplicitOwnedTransfer(
              tree,
              valueInput,
              value,
              inout output
            );
            let children = Array<usize>();
            children.push(value);
            const mutexName = intrinsicMutexName(valueType);
            return pushExpression(
              inout output,
              LoweredExpressionKind.mutexValue,
              mutexName,
              children,
              Array<String>()
            );
          }
        }
      }
      if (generic.base == "Option" && generic.arguments.length == 1) {
        const intrinsic = try intrinsicOptionDeclaration(
          program,
          importedTypes,
          expectedTypeName
        );
        const declaration = match (intrinsic) {
          some(value) => value;
          none => throw `native contextual lowering could not materialize ${expectedTypeName}`;
        };
        if (
          tree.nodes[index].kind == ExpressionKind.callExpression
          && tree.nodes[index].children.length == 2
        ) {
          const callee = tree.nodes[index].children[0];
          if (
            tree.nodes[callee].kind == ExpressionKind.memberExpression
            && tree.nodes[callee].children.length == 1
          ) {
            const receiver = tree.nodes[callee].children[0];
            if (
              tree.nodes[receiver].kind == ExpressionKind.identifierExpression
              && tree.nodes[receiver].value == "Option"
              && tree.nodes[callee].value == "some"
            ) {
              const payloadIndex = tree.nodes[index].children[1];
              let payload = try lowerExpression(
                program,
                importedTypes,
                evidence,
                tree,
                payloadIndex,
                inout output
              );
              payload = wrapImplicitOwnedTransfer(
                tree,
                payloadIndex,
                payload,
                inout output
              );
              let children = Array<usize>();
              children.push(payload);
              let labels = Array<String>();
              labels.push("some");
              return pushExpression(
                inout output,
                LoweredExpressionKind.enumPayloadValue,
                declaration.name,
                children,
                labels
              );
            }
          }
        }
        if (
          tree.nodes[index].kind == ExpressionKind.memberExpression
          && tree.nodes[index].children.length == 1
        ) {
          const receiver = tree.nodes[index].children[0];
          if (
            tree.nodes[receiver].kind == ExpressionKind.identifierExpression
            && tree.nodes[receiver].value == "Option"
            && tree.nodes[index].value == "none"
          ) {
            let labels = Array<String>();
            labels.push("none");
            labels.push("tagged");
            return pushExpression(
              inout output,
              LoweredExpressionKind.enumValue,
              declaration.name,
              Array<usize>(),
              labels
            );
          }
        }
      }
    }
    none => {}
  }
  return try lowerExpression(
    program,
    importedTypes,
    evidence,
    tree,
    index,
    inout output
  );
}

function isExplicitOptionExpression(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): boolean {
  match (resolvedExpressionTypeName(evidence, tree, index)) {
    some(typeName) => {
      if (stringStartsWith(typeName, "__z_Option_")) return true;
      match (genericTypeShape(typeName)) {
        some(generic) => {
          if (generic.base == "Option" && generic.arguments.length == 1) {
            return true;
          }
        }
        none => {}
      }
    }
    none => {}
  }
  let candidate = index;
  if (
    tree.nodes[candidate].kind == ExpressionKind.callExpression
    && tree.nodes[candidate].children.length > 0
  ) candidate = tree.nodes[candidate].children[0];
  if (
    tree.nodes[candidate].kind != ExpressionKind.memberExpression
    || tree.nodes[candidate].children.length != 1
  ) return false;
  const receiver = tree.nodes[candidate].children[0];
  if (tree.nodes[receiver].kind != ExpressionKind.identifierExpression) {
    return false;
  }
  const receiverName = view tree.nodes[receiver].value;
  return receiverName == "Option" || stringStartsWith(receiverName, "Option<");
}

function lowerOptionalFieldExpression(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize,
  in expectedTypeName: String,
  inout output: Array<LoweredExpression>
): usize throws String {
  if (isExplicitOptionExpression(evidence, tree, index)) {
    return try lowerExpressionExpected(
      program,
      importedTypes,
      evidence,
      tree,
      index,
      expectedTypeName,
      inout output
    );
  }
  const intrinsicResult = try intrinsicOptionDeclaration(
    program,
    importedTypes,
    expectedTypeName
  );
  const intrinsic = match (intrinsicResult) {
    some(value) => value;
    none => throw `native optional-field lowering could not materialize ${expectedTypeName}`;
  };
  let payloadTypeName = "";
  match (genericTypeShape(expectedTypeName)) {
    some(generic) => {
      if (generic.base == "Option" && generic.arguments.length == 1) {
        payloadTypeName = generic.arguments[0].copyBytes(
          0,
          generic.arguments[0].byteLength
        );
      }
    }
    none => match (intrinsicOptionPayloadName(expectedTypeName)) {
      some(payload) => payloadTypeName = move payload;
      none => {}
    }
  }
  if (payloadTypeName.byteLength == 0) {
    throw `native optional-field lowering expected Option<T>, found ${expectedTypeName}`;
  }
  let payload = try lowerExpressionExpected(
    program,
    importedTypes,
    evidence,
    tree,
    index,
    payloadTypeName,
    inout output
  );
  payload = wrapImplicitOwnedTransfer(tree, index, payload, inout output);
  let children = Array<usize>();
  children.push(payload);
  let labels = Array<String>();
  labels.push("some");
  return pushExpression(
    inout output,
    LoweredExpressionKind.enumPayloadValue,
    intrinsic.name,
    children,
    labels
  );
}

function lowerOptionalFieldNone(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in typeName: String,
  inout output: Array<LoweredExpression>
): usize throws String {
  const intrinsicResult = try intrinsicOptionDeclaration(
    program,
    importedTypes,
    typeName
  );
  const intrinsic = match (intrinsicResult) {
    some(value) => value;
    none => throw `native optional-field lowering could not materialize ${typeName}`;
  };
  let labels = Array<String>();
  labels.push("none");
  labels.push("tagged");
  return pushExpression(
    inout output,
    LoweredExpressionKind.enumValue,
    intrinsic.name,
    Array<usize>(),
    labels
  );
}

function lowerExpressionSyntax(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in expression: ExpressionSyntax,
  inout output: Array<LoweredExpression>
): usize throws String {
  return match (in expression.tree) {
    some(tree) => {
      const root = tree.root;
      select try lowerExpression(
        program,
        importedTypes,
        evidence,
        tree,
        root,
        inout output
      );
    }
    none => throw "native lowering cannot lower an opaque expression";
  };
}

function loweredSourceEnum(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  index: usize
): LoweredEnum throws String {
  let variants = Array<LoweredVariant>();
  let payloadBearing = false;
  for (const variant of program.enums[index].variants) {
    let payload = Option<LoweredType>.none;
    match (in variant.payload) {
      some(type) => {
        const lowered = try lowerModuleType(program, importedTypes, type);
        payload = Option.some(move lowered);
        payloadBearing = true;
      }
      none => {}
    }
    variants.push(LoweredVariant({
      name: variant.name.copyBytes(0, variant.name.byteLength),
      payload,
    }));
  }
  const loweredName = try lowerModuleTypeName(
    program,
    importedTypes,
    program.enums[index].name
  );
  let nativeCUnderlyingType = "";
  if (program.enums[index].nativeCLayout) {
    match (in program.enums[index].underlyingType) {
      some(type) => {
        nativeCUnderlyingType = type.name.copyBytes(0, type.name.byteLength);
      }
      none => {}
    }
  }
  return LoweredEnum({
    name: loweredName.name.copyBytes(0, loweredName.name.byteLength),
    nativeCName: program.enums[index].nativeCLayout
      ? program.enums[index].name.copyBytes(0, program.enums[index].name.byteLength)
      : "",
    nativeCUnderlyingType,
    variants,
    payloadBearing,
    needsDeinit: moduleEnumNeedsCleanup(program, importedTypes, index, 0),
  });
}

function directThrowingCallResult(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize,
  in ownerName: String
): Option<LoweredEnum> throws String {
  if (
    tree.nodes[index].kind
      == ExpressionKind.executorPlacementExpression
    && tree.nodes[index].children.length == 3
  ) {
    const call = tree.nodes[index].children[2];
    return try directThrowingCallResult(
      program,
      importedTypes,
      evidence,
      tree,
      call,
      ownerName
    );
  }
  if (
    tree.nodes[index].kind == ExpressionKind.awaitExpression
    && tree.nodes[index].children.length == 1
  ) {
    const task = tree.nodes[index].children[0];
    match (evidenceResolvedExpressionTypeName(
      program,
      importedTypes,
      evidence,
      tree,
      task
    )) {
      some(taskTypeName) => match (genericTypeShape(taskTypeName)) {
        some(generic) => {
          if (generic.base == "Task" && generic.arguments.length == 2) {
            const resultName = `Result<${generic.arguments[0]}, ${generic.arguments[1]}>`;
            return try intrinsicResultDeclaration(
              program,
              importedTypes,
              resultName
            );
          }
        }
        none => {}
      }
      none => {}
    }
    match (resolvedExpressionTypeName(evidence, tree, index)) {
      some(successTypeName) => {
        const outer = try throwingFunctionResult(
          program,
          importedTypes,
          ownerName
        );
        match (outer) {
          some(result) => {
            for (const variant of result.variants) {
              if (variant.name != "failure") continue;
              match (in variant.payload) {
                some(errorType) => {
                  const errorTypeName = loweredTypeIdentity(errorType);
                  const resultName = `Result<${successTypeName}, ${errorTypeName}>`;
                  return try intrinsicResultDeclaration(
                    program,
                    importedTypes,
                    resultName
                  );
                }
                none => {}
              }
            }
          }
          none => {}
        }
      }
      none => {}
    }
    return Option<LoweredEnum>.none;
  }
  if (
    tree.nodes[index].kind != ExpressionKind.callExpression
    || tree.nodes[index].children.length == 0
  ) return Option<LoweredEnum>.none;
  for (const resolution of evidence.callResolutions) {
    if (
      resolution.offset != tree.nodes[index].offset
      || resolution.line != tree.nodes[index].line
      || resolution.column != tree.nodes[index].column
      || resolution.errorType.byteLength == 0
    ) continue;
    const resultName = `Result<${resolution.returnType}, ${resolution.errorType}>`;
    return try intrinsicResultDeclaration(
      program,
      importedTypes,
      resultName
    );
  }
  const callee = tree.nodes[index].children[0];
  if (tree.nodes[callee].kind != ExpressionKind.identifierExpression) {
    return Option<LoweredEnum>.none;
  }
  for (const declaration of program.functions) {
    if (declaration.name == tree.nodes[callee].value) {
      match (in declaration.errorType) {
        some(errorType) => {
          const returnName = declaration.returnType.name.copyBytes(
            0,
            declaration.returnType.name.byteLength
          );
          const errorName = errorType.name.copyBytes(0, errorType.name.byteLength);
          const resultName = `Result<${returnName}, ${errorName}>`;
          return try intrinsicResultDeclaration(
            program,
            importedTypes,
            resultName
          );
        }
        none => return Option<LoweredEnum>.none;
      }
    }
  }
  return Option<LoweredEnum>.none;
}

function awaitedResultForSuccessType(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in tree: ExpressionTree,
  index: usize,
  in successType: LoweredType,
  in outer: LoweredEnum
): Option<LoweredEnum> {
  if (tree.nodes[index].kind != ExpressionKind.awaitExpression) {
    return Option<LoweredEnum>.none;
  }
  for (const variant of outer.variants) {
    if (variant.name != "failure") continue;
    match (in variant.payload) {
      some(errorType) => {
        let variants = Array<LoweredVariant>();
        let successPayload = Option<LoweredType>.none;
        if (successType.kind != LoweredTypeKind.voidType) {
          successPayload = Option.some(LoweredType({
            kind: successType.kind,
            name: successType.name.copyBytes(0, successType.name.byteLength),
          }));
        }
        variants.push(LoweredVariant({
          name: "success",
          payload: successPayload,
        }));
        variants.push(LoweredVariant({
          name: "failure",
          payload: Option.some(LoweredType({
            kind: errorType.kind,
            name: errorType.name.copyBytes(0, errorType.name.byteLength),
          })),
        }));
        return Option.some(LoweredEnum({
          name: intrinsicResultName(successType, errorType),
          nativeCName: "",
          nativeCUnderlyingType: "",
          variants,
          payloadBearing: true,
          needsDeinit: moduleTypeNeedsCleanup(
            program,
            importedTypes,
            successType
          ) || moduleTypeNeedsCleanup(program, importedTypes, errorType),
        }));
      }
      none => {}
    }
  }
  return Option<LoweredEnum>.none;
}

function matchSubjectTypeName(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in arena: StatementArena,
  in ownerName: String,
  in tree: ExpressionTree,
  index: usize
): Option<String> {
  match (staticallyResolvedExpressionTypeName(
    program,
    importedTypes,
    evidence,
    arena,
    ownerName,
    tree,
    index
  )) {
    some(name) => return Option.some(move name);
    none => {}
  }
  let subject = index;
  if (
    tree.nodes[subject].kind == ExpressionKind.attemptExpression
    && tree.nodes[subject].children.length == 1
  ) {
    const attempted = tree.nodes[subject].children[0];
    if (
      tree.nodes[attempted].kind == ExpressionKind.callExpression
      && tree.nodes[attempted].children.length > 0
    ) {
      const callee = tree.nodes[attempted].children[0];
      if (tree.nodes[callee].kind == ExpressionKind.identifierExpression) {
        for (const declaration of program.functions) {
          if (declaration.name == tree.nodes[callee].value) {
            match (in declaration.errorType) {
              some(errorType) => {
                const returnName = declaration.returnType.name.copyBytes(
                  0,
                  declaration.returnType.name.byteLength
                );
                const errorName = errorType.name.copyBytes(
                  0,
                  errorType.name.byteLength
                );
                return Option.some(`Result<${returnName}, ${errorName}>`);
              }
              none => {}
            }
          }
        }
      }
    }
  }
  if (
    tree.nodes[subject].kind == ExpressionKind.callExpression
    && tree.nodes[subject].children.length > 0
  ) subject = tree.nodes[subject].children[0];
  if (
    tree.nodes[subject].kind == ExpressionKind.memberExpression
    && tree.nodes[subject].children.length == 1
  ) {
    const receiver = tree.nodes[subject].children[0];
    if (tree.nodes[receiver].kind == ExpressionKind.identifierExpression) {
      return Option.some(tree.nodes[receiver].value.copyBytes(
        0,
        tree.nodes[receiver].value.byteLength
      ));
    }
  }
  if (tree.nodes[subject].kind == ExpressionKind.identifierExpression) {
    const name = tree.nodes[subject].value.copyBytes(
      0,
      tree.nodes[subject].value.byteLength
    );
    for (const statement of arena.nodes) {
      if (
        statement.kind == StatementKind.variableStatement
        && statement.name == name
      ) {
        match (in statement.typeAnnotation) {
          some(type) => return Option.some(type.name.copyBytes(
            0,
            type.name.byteLength
          ));
          none => {
            for (const binding of evidence.bindingResolutions) {
              if (
                binding.offset == statement.nameOffset
                && binding.name == statement.name
              ) {
                return Option.some(binding.typeName.copyBytes(
                  0,
                  binding.typeName.byteLength
                ));
              }
            }
          }
        }
      }
    }
    for (const declaration of program.functions) {
      if (declaration.name == ownerName) {
        for (const parameter of declaration.parameters) {
          if (parameter.name == name) {
            return Option.some(parameter.type.name.copyBytes(
              0,
              parameter.type.name.byteLength
            ));
          }
        }
      }
    }
  }
  if (
    tree.nodes[subject].kind == ExpressionKind.callExpression
    && tree.nodes[subject].children.length > 0
  ) {
    const callee = tree.nodes[subject].children[0];
    if (tree.nodes[callee].kind == ExpressionKind.identifierExpression) {
      for (const declaration of program.functions) {
        if (declaration.name == tree.nodes[callee].value) {
          return Option.some(declaration.returnType.name.copyBytes(
            0,
            declaration.returnType.name.byteLength
          ));
        }
      }
    }
  }
  return Option<String>.none;
}

function matchEnumDeclaration(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in arena: StatementArena,
  in ownerName: String,
  in tree: ExpressionTree,
  root: usize
): LoweredEnum throws String {
  const subjectInput = tree.nodes[root].children[0];
  let resolvedSubjectName = "";
  match (matchSubjectTypeName(
    program,
    importedTypes,
    evidence,
    arena,
    ownerName,
    tree,
    subjectInput
  )) {
    some(name) => {
      resolvedSubjectName = name.copyBytes(0, name.byteLength);
      const intrinsic = try intrinsicEnumDeclaration(
        program,
        importedTypes,
        name
      );
      match (intrinsic) {
        some(declaration) => return declaration;
        none => {}
      }
      match (enumIndex(program, name)) {
        some(index) => return try loweredSourceEnum(
          program,
          importedTypes,
          index
        );
        none => {}
      }
      match (importedEnumDeclaration(importedTypes, name)) {
        some(declaration) => return declaration;
        none => {}
      }
    }
    none => {}
  }
  let found = Option<usize>.none;
  let enumPosition: usize = 0;
  while (enumPosition < program.enums.length) {
    if (program.enums[enumPosition].variants.length == tree.nodes[root].children.length - 1) {
      let allPresent = true;
      let armPosition: usize = 1;
      while (armPosition < tree.nodes[root].children.length) {
        const arm = tree.nodes[root].children[armPosition];
        let present = false;
        for (const variant of program.enums[enumPosition].variants) {
          if (variant.name == tree.nodes[arm].value) present = true;
        }
        if (!present) allPresent = false;
        armPosition = armPosition + 1;
      }
      if (allPresent) {
        match (found) {
          some(_) => throw "native match lowering cannot disambiguate enum variants yet";
          none => found = Option.some(enumPosition);
        }
      }
    }
    enumPosition = enumPosition + 1;
  }
  return match (found) {
    some(index) => try loweredSourceEnum(program, importedTypes, index);
    none => {
      const subject = tree.nodes[root].children[0];
      const subjectKind = expressionKindName(tree.nodes[subject].kind);
      if (resolvedSubjectName.byteLength > 0) {
        throw `native match lowering could not lower ${resolvedSubjectName} for ${subjectKind} subject at ${tree.nodes[subject].line}:${tree.nodes[subject].column}`;
      }
      throw `native match lowering could not resolve ${subjectKind} subject at ${tree.nodes[subject].line}:${tree.nodes[subject].column}`;
    }
  };
}

function valueArmIsIdentifier(
  in arena: StatementArena,
  index: usize,
  in name: String
): boolean {
  if (
    arena.nodes[index].kind == StatementKind.expressionStatement
    || arena.nodes[index].kind == StatementKind.selectStatement
  ) {
    return match (in arena.nodes[index].expression) {
      some(expression) => syntaxIsIdentifier(expression, name);
      none => false;
    };
  }
  if (
    arena.nodes[index].kind == StatementKind.blockStatement
    && arena.nodes[index].children.length > 0
  ) {
    const finalChild = arena.nodes[index].children[
      arena.nodes[index].children.length - 1
    ];
    return valueArmIsIdentifier(
      arena,
      finalChild,
      name
    );
  }
  return false;
}

function lowerValueDestination(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in ownerName: String,
  in expression: ExpressionSyntax,
  returnValue: boolean,
  in valueBinding: String,
  inout expressions: Array<LoweredExpression>,
  inout statements: Array<LoweredStatement>
): usize throws String {
  match (in expression.tree) {
    some(tree) => {
      const root = tree.root;
      if (
        tree.nodes[root].kind == ExpressionKind.tryExpression
        && tree.nodes[root].children.length == 1
      ) {
        const attempted = tree.nodes[root].children[0];
        const innerResult = try directThrowingCallResult(
          program,
          importedTypes,
          evidence,
          tree,
          attempted,
          ownerName
        );
        const inner = match (innerResult) {
          some(declaration) => declaration;
          none => throw "native value-match try lowering requires one direct throwing function call";
        };
        const outerResult = try throwingFunctionResult(
          program,
          importedTypes,
          ownerName
        );
        const outer = match (outerResult) {
          some(declaration) => declaration;
          none => throw "native value-match try lowering requires an enclosing throwing function";
        };
        const call = try lowerExpression(
          program,
          importedTypes,
          evidence,
          tree,
          attempted,
          inout expressions
        );
        if (returnValue) {
          if (inner.name != outer.name) {
            throw "native returning value-match try lowering requires identical propagated Result storage";
          }
          const loweredReturn = statements.length;
          statements.push(LoweredStatement({
            kind: LoweredStatementKind.returnStatement,
            mutableBinding: false,
            name: "",
            type: Option<LoweredType>.none,
            expression: Option.some(call),
            secondExpression: Option<usize>.none,
            children: Array<usize>(),
            cleanups: Array<LoweredCleanup>(),
            liveFlag: "",
            labels: Array<String>(),
            matchConsumesSubject: false,
            matchBindingNeedsCleanup: false,
          }));
          return loweredReturn;
        }
        let successType = Option<LoweredType>.none;
        for (const variant of inner.variants) {
          if (variant.name != "success") continue;
          match (in variant.payload) {
            some(payload) => successType = Option.some(LoweredType({
              kind: payload.kind,
              name: payload.name.copyBytes(0, payload.name.byteLength),
            }));
            none => {}
          }
        }
        const selectedType = match (successType) {
          some(type) => type;
          none => throw "native selecting value-match try lowering requires a success payload";
        };
        let labels = Array<String>();
        labels.push(valueBinding.copyBytes(0, valueBinding.byteLength));
        labels.push(outer.name.copyBytes(0, outer.name.byteLength));
        const loweredTry = statements.length;
        statements.push(LoweredStatement({
          kind: LoweredStatementKind.tryStatement,
          mutableBinding: false,
          name: inner.name.copyBytes(0, inner.name.byteLength),
          type: Option<LoweredType>.some(move selectedType),
          expression: Option.some(call),
          secondExpression: Option<usize>.none,
          children: Array<usize>(),
          cleanups: Array<LoweredCleanup>(),
          liveFlag: "",
          labels,
          matchConsumesSubject: false,
          matchBindingNeedsCleanup: false,
        }));
        return loweredTry;
      }
    }
    none => {}
  }
  let value = try lowerExpressionSyntax(
    program,
    importedTypes,
    evidence,
    expression,
    inout expressions
  );
  match (in expression.tree) {
    some(tree) => {
      const root = tree.root;
      value = wrapImplicitOwnedTransfer(
        tree,
        root,
        value,
        inout expressions
      );
    }
    none => {}
  }
  const loweredBody = statements.length;
  if (returnValue) {
    let returnedValue = value;
    const outerResult = try throwingFunctionResult(
      program,
      importedTypes,
      ownerName
    );
    match (outerResult) {
      some(declaration) => {
        let children = Array<usize>();
        children.push(value);
        let labels = Array<String>();
        labels.push("success");
        returnedValue = pushExpression(
          inout expressions,
          LoweredExpressionKind.enumPayloadValue,
          declaration.name,
          children,
          labels
        );
      }
      none => {}
    }
    statements.push(LoweredStatement({
      kind: LoweredStatementKind.returnStatement,
      mutableBinding: false,
      name: "",
      type: Option<LoweredType>.none,
      expression: Option.some(returnedValue),
      secondExpression: Option<usize>.none,
      children: Array<usize>(),
      cleanups: Array<LoweredCleanup>(),
      liveFlag: "",
      labels: Array<String>(),
      matchConsumesSubject: false,
      matchBindingNeedsCleanup: false,
    }));
  } else {
    const target = pushExpression(
      inout expressions,
      LoweredExpressionKind.localValue,
      valueBinding,
      Array<usize>(),
      Array<String>()
    );
    statements.push(LoweredStatement({
      kind: LoweredStatementKind.assignmentStatement,
      mutableBinding: false,
      name: "",
      type: Option<LoweredType>.none,
      expression: Option.some(target),
      secondExpression: Option.some(value),
      children: Array<usize>(),
      cleanups: Array<LoweredCleanup>(),
      liveFlag: "",
      labels: Array<String>(),
      matchConsumesSubject: false,
      matchBindingNeedsCleanup: false,
    }));
  }
  return loweredBody;
}

function lowerValueArmStatement(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in arena: StatementArena,
  in ownerName: String,
  index: usize,
  returnValue: boolean,
  in valueBinding: String,
  inout expressions: Array<LoweredExpression>,
  inout statements: Array<LoweredStatement>
): usize throws String {
  if (
    arena.nodes[index].kind == StatementKind.returnStatement
    || arena.nodes[index].kind == StatementKind.throwStatement
  ) {
    return try lowerStatement(
      program,
      importedTypes,
      evidence,
      arena,
      ownerName,
      index,
      inout expressions,
      inout statements
    );
  }
  if (
    arena.nodes[index].kind == StatementKind.expressionStatement
    || arena.nodes[index].kind == StatementKind.selectStatement
  ) {
    return match (in arena.nodes[index].expression) {
      some(expression) => try lowerValueDestination(
        program,
        importedTypes,
        evidence,
        ownerName,
        expression,
        returnValue,
        valueBinding,
        inout expressions,
        inout statements
      );
      none => throw "native value-match lowering received an empty arm";
    };
  }
  if (arena.nodes[index].kind == StatementKind.blockStatement) {
    if (arena.nodes[index].children.length == 0) {
      throw "native value-match lowering received an empty block arm";
    }
    let children = Array<usize>();
    let childIndex: usize = 0;
    while (childIndex < arena.nodes[index].children.length) {
      const sourceChild = arena.nodes[index].children[childIndex];
      let loweredChild: usize = 0;
      if (childIndex + 1 == arena.nodes[index].children.length) {
        if (
          arena.nodes[sourceChild].kind != StatementKind.selectStatement
          && arena.nodes[sourceChild].kind != StatementKind.returnStatement
          && arena.nodes[sourceChild].kind != StatementKind.throwStatement
        ) {
          throw "native value-match lowering requires a final select in a block arm";
        }
        loweredChild = try lowerValueArmStatement(
          program,
          importedTypes,
          evidence,
          arena,
          ownerName,
          sourceChild,
          returnValue,
          valueBinding,
          inout expressions,
          inout statements
        );
      } else {
        loweredChild = try lowerStatement(
          program,
          importedTypes,
          evidence,
          arena,
          ownerName,
          sourceChild,
          inout expressions,
          inout statements
        );
      }
      children.push(loweredChild);
      childIndex = childIndex + 1;
    }
    const block = statements.length;
    statements.push(LoweredStatement({
      kind: LoweredStatementKind.blockStatement,
      mutableBinding: false,
      name: "",
      type: Option<LoweredType>.none,
      expression: Option<usize>.none,
      secondExpression: Option<usize>.none,
      children,
      cleanups: Array<LoweredCleanup>(),
      liveFlag: "",
      labels: Array<String>(),
      matchConsumesSubject: false,
      matchBindingNeedsCleanup: false,
    }));
    return block;
  }
  throw "native value-match lowering requires a concise expression or selecting block arm yet";
}

function lowerMatchTree(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in arena: StatementArena,
  in ownerName: String,
  in tree: ExpressionTree,
  root: usize,
  returnValueArms: boolean,
  in valueBinding: String,
  inout expressions: Array<LoweredExpression>,
  inout statements: Array<LoweredStatement>
): usize throws String {
  if (
    tree.nodes[root].kind != ExpressionKind.matchExpression
    || tree.nodes[root].children.length < 2
  ) {
    throw "native match lowering received a malformed match expression";
  }
  const subjectInput = tree.nodes[root].children[0];
  const subject = try lowerExpression(
    program,
    importedTypes,
    evidence,
    tree,
    subjectInput,
    inout expressions
  );
  const declaration = try matchEnumDeclaration(
    program,
    importedTypes,
    evidence,
    arena,
    ownerName,
    tree,
    root
  );
  let armStatements = Array<usize>();
  let armPosition: usize = 1;
  while (armPosition < tree.nodes[root].children.length) {
    const arm = tree.nodes[root].children[armPosition];
    if (tree.nodes[arm].kind != ExpressionKind.matchArmExpression) {
      throw "native match lowering received a malformed match arm";
    }
    let payloadType = Option<LoweredType>.none;
    for (const variant of declaration.variants) {
      if (variant.name == tree.nodes[arm].value) {
        match (in variant.payload) {
          some(type) => {
            payloadType = Option.some(LoweredType({
              kind: type.kind,
              name: type.name.copyBytes(0, type.name.byteLength),
            }));
          }
          none => {}
        }
      }
    }
    const armExpressionStart = expressions.length;
    const armStatementStart = statements.length;
    let sourcePayloadBinding = "";
    let emittedPayloadBinding = "";
    let labels = Array<String>();
    if (tree.nodes[arm].children.length > 0) {
      const binding = tree.nodes[arm].children[0];
      if (tree.nodes[binding].kind != ExpressionKind.matchBindingExpression) {
        throw "native match lowering only supports one direct payload binding yet";
      }
      sourcePayloadBinding = tree.nodes[binding].value.copyBytes(
        0,
        tree.nodes[binding].value.byteLength
      );
      emittedPayloadBinding =
        `_z_stage1_match_payload_${armExpressionStart}_${armPosition}`;
      labels.push(emittedPayloadBinding.copyBytes(
        0,
        emittedPayloadBinding.byteLength
      ));
    }
    let payloadTransfersOut = false;
    if (sourcePayloadBinding.byteLength > 0) {
      for (const bodyIndex of tree.nodes[arm].statements) {
        if (
          statementMovesName(
            program,
            evidence,
            arena,
            arena.nodes[bodyIndex],
            sourcePayloadBinding
          )
        ) payloadTransfersOut = true;
      }
    }
    let children = Array<usize>();
    if (returnValueArms || valueBinding.byteLength > 0) {
      if (tree.nodes[arm].statements.length != 1) {
        throw "native value-match lowering requires one value-producing arm body";
      }
      const bodyIndex = tree.nodes[arm].statements[0];
      if (
        labels.length == 1
        && valueArmIsIdentifier(arena, bodyIndex, sourcePayloadBinding)
      ) payloadTransfersOut = true;
      const loweredBody = try lowerValueArmStatement(
        program,
        importedTypes,
        evidence,
        arena,
        ownerName,
        bodyIndex,
        returnValueArms,
        valueBinding,
        inout expressions,
        inout statements
      );
      children.push(loweredBody);
    } else {
      for (const bodyIndex of tree.nodes[arm].statements) {
        const loweredBody = try lowerStatement(
          program,
          importedTypes,
          evidence,
          arena,
          ownerName,
          bodyIndex,
          inout expressions,
          inout statements
        );
        children.push(loweredBody);
      }
    }
    if (
      sourcePayloadBinding.byteLength > 0
      && emittedPayloadBinding != sourcePayloadBinding
    ) {
      let expressionIndex = armExpressionStart;
      while (expressionIndex < expressions.length) {
        let assignmentTarget = false;
        let statementIndex = armStatementStart;
        while (statementIndex < statements.length) {
          if (
            statements[statementIndex].kind
              == LoweredStatementKind.assignmentStatement
          ) {
            match (in statements[statementIndex].expression) {
              some(target) => {
                if (target == expressionIndex) assignmentTarget = true;
              }
              none => {}
            }
          }
          statementIndex = statementIndex + 1;
        }
        if (
          !assignmentTarget
          &&
          expressions[expressionIndex].kind
            == LoweredExpressionKind.localValue
          && expressions[expressionIndex].value == sourcePayloadBinding
        ) {
          expressions[expressionIndex].value = emittedPayloadBinding.copyBytes(
            0,
            emittedPayloadBinding.byteLength
          );
        }
        expressionIndex = expressionIndex + 1;
      }
    }
    const matchBindingNeedsCleanup = match (in payloadType) {
      some(type) => tree.nodes[root].value != "in"
        && moduleTypeNeedsCleanup(program, importedTypes, type)
        && !payloadTransfersOut;
      none => false;
    };
    const loweredArm = statements.length;
    statements.push(LoweredStatement({
      kind: LoweredStatementKind.matchArmStatement,
      mutableBinding: false,
      name: tree.nodes[arm].value.copyBytes(
        0,
        tree.nodes[arm].value.byteLength
      ),
      type: payloadType,
      expression: Option<usize>.none,
      secondExpression: Option<usize>.none,
      children,
      cleanups: Array<LoweredCleanup>(),
      liveFlag: "",
      labels,
      matchConsumesSubject: false,
      matchBindingNeedsCleanup,
    }));
    armStatements.push(loweredArm);
    armPosition = armPosition + 1;
  }
  let labels = Array<String>();
  if (declaration.payloadBearing) labels.push("tagged");
  const outputIndex = statements.length;
  statements.push(LoweredStatement({
    kind: LoweredStatementKind.matchStatement,
    mutableBinding: false,
    name: declaration.name.copyBytes(0, declaration.name.byteLength),
    type: Option.some(LoweredType({
      kind: LoweredTypeKind.enumType,
      name: declaration.name.copyBytes(0, declaration.name.byteLength),
    })),
    expression: Option.some(subject),
    secondExpression: Option<usize>.none,
    children: armStatements,
    cleanups: Array<LoweredCleanup>(),
    liveFlag: "",
    labels,
    matchConsumesSubject: tree.nodes[root].value != "in",
    matchBindingNeedsCleanup: false,
  }));
  return outputIndex;
}

function standardTestBindingName(
  in program: Program,
  in importedName: String
): String {
  for (const declaration of program.imports) {
    if (declaration.header != "std/test") continue;
    for (const binding of declaration.bindings) {
      if (binding.importedName == importedName) {
        return binding.localName.copyBytes(0, binding.localName.byteLength);
      }
    }
  }
  return "";
}

function isImportedStandardBinding(
  in program: Program,
  in header: String,
  in importedName: String,
  in localName: String
): boolean {
  for (const declaration of program.imports) {
    if (declaration.header != header) continue;
    for (const binding of declaration.bindings) {
      if (
        binding.importedName == importedName
        && binding.localName == localName
      ) return true;
    }
  }
  return false;
}

function testBorrowInput(in tree: ExpressionTree, index: usize): usize {
  if (
    tree.nodes[index].kind == ExpressionKind.argumentReferenceExpression
    && tree.nodes[index].value == "in"
    && tree.nodes[index].children.length == 1
  ) return tree.nodes[index].children[0];
  return index;
}

function testExpressionTypeName(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in arena: StatementArena,
  in ownerName: String,
  in tree: ExpressionTree,
  index: usize,
  in contextualType: String
): Option<String> {
  match (staticallyResolvedExpressionTypeName(
    program,
    importedTypes,
    evidence,
    arena,
    ownerName,
    tree,
    index
  )) {
    some(name) => return Option.some(move name);
    none => {}
  }
  if (tree.nodes[index].kind == ExpressionKind.stringExpression) {
    return Option.some("String");
  }
  if (tree.nodes[index].kind == ExpressionKind.booleanExpression) {
    return Option.some("boolean");
  }
  if (tree.nodes[index].kind == ExpressionKind.numberExpression) {
    if (
      contextualType == "i8"
      || contextualType == "i16"
      || contextualType == "i32"
      || contextualType == "i64"
      || contextualType == "isize"
      || contextualType == "u8"
      || contextualType == "u16"
      || contextualType == "u32"
      || contextualType == "u64"
      || contextualType == "usize"
      || contextualType == "f32"
      || contextualType == "f64"
    ) return Option.some(contextualType.copyBytes(
      0,
      contextualType.byteLength
    ));
    return Option.some("i32");
  }
  if (tree.nodes[index].kind == ExpressionKind.callExpression) {
    for (const resolution of evidence.callResolutions) {
      if (
        resolution.offset == tree.nodes[index].offset
        && resolution.line == tree.nodes[index].line
        && resolution.column == tree.nodes[index].column
        && resolution.returnType.byteLength > 0
      ) return Option.some(resolution.returnType.copyBytes(
        0,
        resolution.returnType.byteLength
      ));
    }
  }
  return Option<String>.none;
}

function threadCaptureBindingOffset(
  in program: Program,
  in arena: StatementArena,
  in ownerName: String,
  in name: String,
  useOffset: usize
): usize throws String {
  let resolvedOffset: usize = 0;
  for (const statement of arena.nodes) {
    if (
      statement.kind == StatementKind.variableStatement
      && statement.name == name
      && statement.nameOffset < useOffset
      && statement.nameOffset >= resolvedOffset
    ) resolvedOffset = statement.nameOffset;
  }
  if (resolvedOffset > 0) return resolvedOffset;
  for (const declaration of program.functions) {
    if (declaration.name != ownerName) continue;
    for (const parameter of declaration.parameters) {
      if (parameter.name == name) return parameter.offset;
    }
  }
  throw `native thread.spawn cannot resolve binding identity for capture ${name}`;
}

function resolveThreadCaptureBindingOffsets(
  in program: Program,
  in arena: StatementArena,
  in ownerName: String,
  useOffset: usize,
  expressionIndex: usize,
  inout expressions: Array<LoweredExpression>
): void throws String {
  if (
    expressions[expressionIndex].labels.length < 5
    || (expressions[expressionIndex].labels.length - 5) % 2 != 0
  ) throw "native thread.spawn lowering lost its capture evidence";
  if (expressions[expressionIndex].captureBindingOffsets.length > 0) return;
  let captureLabel: usize = 5;
  while (captureLabel + 1 < expressions[expressionIndex].labels.length) {
    const name = expressions[expressionIndex].labels[captureLabel].copyBytes(
      0,
      expressions[expressionIndex].labels[captureLabel].byteLength
    );
    const bindingOffset = try threadCaptureBindingOffset(
      program,
      arena,
      ownerName,
      name,
      useOffset
    );
    expressions[expressionIndex].captureBindingOffsets.push(bindingOffset);
    captureLabel = captureLabel + 2;
  }
}

function completeNativeClosureBlocks(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in arena: StatementArena,
  in ownerName: String,
  sourceStatementIndex: usize,
  start: usize,
  inout expressions: Array<LoweredExpression>,
  inout statements: Array<LoweredStatement>
): void throws String {
  const closureUseOffset = arena.nodes[sourceStatementIndex].offset;
  let expressionIndex = start;
  while (expressionIndex < expressions.length) {
    if (
      expressions[expressionIndex].kind
        == LoweredExpressionKind.threadSpawn
      && expressions[expressionIndex].labels.length >= 1
      && expressions[expressionIndex].labels[0] != "block"
    ) try resolveThreadCaptureBindingOffsets(
      program,
      arena,
      ownerName,
      closureUseOffset,
      expressionIndex,
      inout expressions
    );
    if (
      expressions[expressionIndex].kind
        == LoweredExpressionKind.threadSpawn
      && expressions[expressionIndex].labels.length >= 1
      && expressions[expressionIndex].labels[0] == "block"
    ) {
      let sourceStatements = Array<usize>();
      for (const source of expressions[expressionIndex].statements) {
        sourceStatements.push(source);
      }
      let loweredStatements = Array<usize>();
      const bodyExpressionStart = expressions.length;
      const bodyStatementStart = statements.length;
      for (const source of sourceStatements) {
        const lowered = try lowerStatement(
          program,
          importedTypes,
          evidence,
          arena,
          ownerName,
          source,
          inout expressions,
          inout statements
        );
        loweredStatements.push(lowered);
      }
      if (expressions[expressionIndex].labels[3].byteLength > 0) {
        const enclosingResult = try throwingFunctionResult(
          program,
          importedTypes,
          ownerName
        );
        const resultName = expressions[expressionIndex].labels[1].copyBytes(
          0,
          expressions[expressionIndex].labels[1].byteLength
        );
        let workerStatement = bodyStatementStart;
        while (workerStatement < statements.length) {
          if (
            statements[workerStatement].kind
              == LoweredStatementKind.returnStatement
          ) {
            const returned = match (in statements[workerStatement].expression) {
              some(value) => value;
              none => throw "native fallible worker lowering requires an explicit return value";
            };
            if (
              expressions[returned].kind
                == LoweredExpressionKind.threadMainCall
              && expressions[returned].labels.length > 0
              && expressions[returned].labels[0] == resultName
            ) {
              workerStatement = workerStatement + 1;
              continue;
            }
            let workerPayload = returned;
            match (in enclosingResult) {
              some(outer) => {
                if (
                  expressions[returned].kind
                    == LoweredExpressionKind.enumPayloadValue
                  && expressions[returned].value == outer.name
                  && expressions[returned].children.length == 1
                ) workerPayload = expressions[returned].children[0];
              }
              none => {}
            }
            let variant = "success";
            if (
              statements[workerStatement].labels.length > 0
              && statements[workerStatement].labels[0] == "throw"
            ) variant = "failure";
            let resultChildren = Array<usize>();
            resultChildren.push(workerPayload);
            let resultLabels = Array<String>();
            resultLabels.push(move variant);
            const wrapped = pushExpression(
              inout expressions,
              LoweredExpressionKind.enumPayloadValue,
              resultName,
              resultChildren,
              resultLabels
            );
            statements[workerStatement].expression = Option.some(wrapped);
          }
          workerStatement = workerStatement + 1;
        }
      }
      let workerReturnType = LoweredType({
        kind: LoweredTypeKind.enumType,
        name: expressions[expressionIndex].labels[1].copyBytes(
          0,
          expressions[expressionIndex].labels[1].byteLength
        ),
      });
      if (expressions[expressionIndex].labels[3].byteLength == 0) {
        workerReturnType = try lowerModuleTypeName(
          program,
          importedTypes,
          expressions[expressionIndex].labels[1]
        );
      }
      let workerReturnStatement = bodyStatementStart;
      while (workerReturnStatement < statements.length) {
        if (
          statements[workerReturnStatement].kind
            == LoweredStatementKind.returnStatement
        ) statements[workerReturnStatement].type = Option.some(LoweredType({
          kind: workerReturnType.kind,
          name: workerReturnType.name.copyBytes(
            0,
            workerReturnType.name.byteLength
          ),
        }));
        workerReturnStatement = workerReturnStatement + 1;
      }
      let placedExpression = bodyExpressionStart;
      while (placedExpression < expressions.length) {
        if (
          expressions[placedExpression].kind
            == LoweredExpressionKind.threadMainCall
        ) {
          if (ownerName != "main") {
            throw "native thread.main placement currently requires a task created in main";
          }
          expressions[placedExpression].value = expressions[expressionIndex]
            .value.copyBytes(
              0,
              expressions[expressionIndex].value.byteLength
            );
        }
        placedExpression = placedExpression + 1;
      }
      const bodyExpressionEnd = expressions.length;
      let captureUseOffset: usize = 0;
      if (sourceStatements.length > 0) {
        captureUseOffset = arena.nodes[sourceStatements[0]].offset;
      }
      const captures = try collectThreadClosureCaptures(
        program,
        importedTypes,
        evidence,
        ownerName,
        expressions,
        bodyExpressionStart,
        statements,
        bodyStatementStart,
        captureUseOffset
      );
      if (expressions[expressionIndex].labels.length < 5) {
        throw "native thread.spawn lowering lost its capture mode";
      }
      try validateOwnedThreadCaptures(
        captures,
        expressions[expressionIndex].labels[4],
        expressions,
        bodyExpressionStart
      );
      for (const capture of captures) {
        rewriteClosureParameterValues(
          inout expressions,
          bodyExpressionStart,
          capture.name
        );
        expressions[expressionIndex].labels.push(capture.name.copyBytes(
          0,
          capture.name.byteLength
        ));
        expressions[expressionIndex].labels.push(
          loweredTypeIdentity(capture.type)
        );
        const captureValue = pushThreadCaptureValue(
          inout expressions,
          capture
        );
        expressions[expressionIndex].children.push(captureValue);
      }
      try resolveThreadCaptureBindingOffsets(
        program,
        arena,
        ownerName,
        closureUseOffset,
        expressionIndex,
        inout expressions
      );
      let workerLiveFlags = Array<LoweredLiveFlag>();
      const inherited = Array<LoweredCleanup>();
      const loopCleanups = Array<LoweredCleanup>();
      const workerIntroduced = try planCleanupSequence(
        program,
        importedTypes,
        evidence,
        arena,
        ownerName,
        sourceStatements,
        loweredStatements,
        inherited,
        expressions,
        inout statements,
        inout workerLiveFlags,
        false,
        loopCleanups
      );
      if (
        workerIntroduced.length > 0
        && sequenceFallsThrough(arena, sourceStatements)
        && loweredSequenceFallsThrough(statements, loweredStatements)
      ) {
        throw "native cleanup-bearing thread.spawn body cannot fall through without returning its result";
      }
      attachMoveLiveFlagsRange(
        inout expressions,
        workerLiveFlags,
        bodyExpressionStart,
        bodyExpressionEnd
      );
      attachThreadCaptureMoveFlags(
        inout expressions,
        bodyExpressionStart,
        bodyExpressionEnd,
        captures
      );
      markWorkerOwnedMoveRange(
        inout expressions,
        bodyExpressionStart,
        bodyExpressionEnd
      );
      expressions[expressionIndex].statements = move loweredStatements;
      expressions[expressionIndex].labels[0] = "lowered-block";
      expressionIndex = expressionIndex + 1;
      continue;
    }
    if (
      expressions[expressionIndex].kind
        != LoweredExpressionKind.mutexWithLock
      || expressions[expressionIndex].labels.length < 4
      || expressions[expressionIndex].labels[3] != "block"
    ) {
      expressionIndex = expressionIndex + 1;
      continue;
    }
    let sourceStatements = Array<usize>();
    for (const source of expressions[expressionIndex].statements) {
      sourceStatements.push(source);
    }
    let loweredStatements = Array<usize>();
    const bodyExpressionStart = expressions.length;
    const bodyStatementStart = statements.length;
    for (const source of sourceStatements) {
      const lowered = try lowerStatement(
        program,
        importedTypes,
        evidence,
        arena,
        ownerName,
        source,
        inout expressions,
        inout statements
      );
      loweredStatements.push(lowered);
    }
    const parameterName = expressions[expressionIndex].labels[0].copyBytes(
      0,
      expressions[expressionIndex].labels[0].byteLength
    );
    let useOffset: usize = 0;
    if (sourceStatements.length > 0) {
      useOffset = arena.nodes[sourceStatements[0]].offset;
    }
    const captures = try collectMutexClosureCaptures(
      program,
      importedTypes,
      evidence,
      ownerName,
      expressions,
      bodyExpressionStart,
      parameterName,
      useOffset
    );
    rewriteClosureParameterValues(
      inout expressions,
      bodyExpressionStart,
      parameterName
    );
    for (const capture of captures) {
      rewriteClosureParameterValues(
        inout expressions,
        bodyExpressionStart,
        capture.name
      );
      expressions[expressionIndex].labels.push(capture.name.copyBytes(
        0,
        capture.name.byteLength
      ));
      expressions[expressionIndex].labels.push(
        loweredTypeIdentity(capture.type)
      );
      const captureValue = pushExpression(
        inout expressions,
        LoweredExpressionKind.localValue,
        capture.name,
        Array<usize>(),
        Array<String>()
      );
      expressions[expressionIndex].children.push(captureValue);
    }
    let statementIndex = bodyStatementStart;
    while (statementIndex < statements.length) {
      match (in statements[statementIndex].type) {
        some(type) => {
          if (moduleTypeNeedsCleanup(program, importedTypes, type)) {
            throw "native Mutex.withLock block closures do not support cleanup-bearing local values yet";
          }
        }
        none => {}
      }
      statementIndex = statementIndex + 1;
    }
    expressions[expressionIndex].statements = move loweredStatements;
    expressions[expressionIndex].labels[3] = "lowered-block";
    expressionIndex = expressionIndex + 1;
  }
}

function expressionTreeContainsTry(
  in tree: ExpressionTree,
  index: usize
): boolean {
  if (tree.nodes[index].kind == ExpressionKind.tryExpression) return true;
  if (tree.nodes[index].kind == ExpressionKind.closureExpression) return false;
  for (const child of tree.nodes[index].children) {
    if (expressionTreeContainsTry(tree, child)) return true;
  }
  return false;
}

function expressionTreeContainsSuspension(
  in tree: ExpressionTree,
  index: usize
): boolean {
  if (
    tree.nodes[index].kind == ExpressionKind.awaitExpression
    || tree.nodes[index].kind
      == ExpressionKind.executorPlacementExpression
  ) return true;
  if (tree.nodes[index].kind == ExpressionKind.closureExpression) return false;
  for (const child of tree.nodes[index].children) {
    if (expressionTreeContainsSuspension(tree, child)) return true;
  }
  return false;
}

function statementContainsSuspension(
  in arena: StatementArena,
  index: usize
): boolean {
  if (
    arena.nodes[index].kind == StatementKind.asyncScopeStatement
    || arena.nodes[index].kind == StatementKind.forAwaitStatement
    || arena.nodes[index].kind == StatementKind.forTryAwaitStatement
  ) return true;
  match (in arena.nodes[index].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const root = tree.root;
        if (expressionTreeContainsSuspension(tree, root)) return true;
      }
      none => {}
    }
    none => {}
  }
  match (in arena.nodes[index].secondExpression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const root = tree.root;
        if (expressionTreeContainsSuspension(tree, root)) return true;
      }
      none => {}
    }
    none => {}
  }
  for (const child of arena.nodes[index].children) {
    if (statementContainsSuspension(arena, child)) return true;
  }
  return false;
}

function mainDelayMillisecondsAtRoot(
  in program: Program,
  in declaration: FunctionDeclaration,
  rootStatement: usize
): String throws String {
  if (!statementContainsSuspension(declaration.body, rootStatement)) return "";
  if (
    declaration.body.nodes[rootStatement].kind
      != StatementKind.expressionStatement
  ) {
    throw `native lowering requires every suspension in ${declaration.name} to be a top-level await delay(integer-literal)`;
  }
  match (in declaration.body.nodes[rootStatement].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const root = tree.root;
        if (
          tree.nodes[root].kind == ExpressionKind.awaitExpression
          && tree.nodes[root].children.length == 1
        ) {
          const operation = tree.nodes[root].children[0];
          if (
            tree.nodes[operation].kind == ExpressionKind.callExpression
            && tree.nodes[operation].children.length == 2
          ) {
            const callee = tree.nodes[operation].children[0];
            const milliseconds = tree.nodes[operation].children[1];
            if (
              tree.nodes[callee].kind == ExpressionKind.identifierExpression
              && isImportedStandardBinding(
                program,
                "std/time",
                "delay",
                tree.nodes[callee].value
              )
              && tree.nodes[milliseconds].kind
                == ExpressionKind.numberExpression
            ) return tree.nodes[milliseconds].value.copyBytes(
              0,
              tree.nodes[milliseconds].value.byteLength
            );
          }
        }
      }
      none => {}
    }
    none => {}
  }
  throw `native lowering requires every suspension in ${declaration.name} to be a top-level await delay(integer-literal)`;
}

function statementExpressionContainsTry(
  in arena: StatementArena,
  index: usize
): boolean {
  match (in arena.nodes[index].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const root = tree.root;
        return expressionTreeContainsTry(tree, root);
      }
      none => {}
    }
    none => {}
  }
  return false;
}

function expressionTreeReferencesName(
  in tree: ExpressionTree,
  index: usize,
  in name: String
): boolean {
  if (
    (
      tree.nodes[index].kind == ExpressionKind.identifierExpression
      || tree.nodes[index].kind == ExpressionKind.argumentBindingExpression
    )
    && tree.nodes[index].value == name
  ) return true;
  for (const child of tree.nodes[index].children) {
    if (expressionTreeReferencesName(tree, child, name)) return true;
  }
  return false;
}

function expressionTreeWritesName(
  in program: Program,
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize,
  in name: String
): boolean {
  if (
    tree.nodes[index].kind == ExpressionKind.callExpression
    && tree.nodes[index].children.length > 0
  ) {
    const callee = tree.nodes[index].children[0];
    if (
      tree.nodes[callee].kind == ExpressionKind.memberExpression
      && tree.nodes[callee].children.length == 1
      && resolvedCallReceiverMode(evidence, tree, index) == "inout"
    ) {
      const receiver = tree.nodes[callee].children[0];
      if (expressionTreeReferencesName(tree, receiver, name)) return true;
    }
    const parameterModes = resolvedCallParameterModes(
      program,
      evidence,
      tree,
      index
    );
    let argument: usize = 1;
    while (
      argument < tree.nodes[index].children.length
      && argument - 1 < parameterModes.length
    ) {
      if (
        (
          parameterModes[argument - 1] == "inout"
          || parameterModes[argument - 1] == "out"
        )
      ) {
        const argumentValue = tree.nodes[index].children[argument];
        if (expressionTreeReferencesName(
          tree,
          argumentValue,
          name
        )) return true;
      }
      argument = argument + 1;
    }
  }
  for (const child of tree.nodes[index].children) {
    if (expressionTreeWritesName(
      program,
      evidence,
      tree,
      child,
      name
    )) return true;
  }
  return false;
}

function statementExpressionWritesName(
  in program: Program,
  in evidence: ModuleSemanticEvidence,
  in arena: StatementArena,
  index: usize,
  in name: String
): boolean {
  match (in arena.nodes[index].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const root = tree.root;
        return expressionTreeWritesName(
          program,
          evidence,
          tree,
          root,
          name
        );
      }
      none => {}
    }
    none => {}
  }
  return false;
}

function collectNestedTryExpressions(
  in tree: ExpressionTree,
  index: usize,
  includeRoot: boolean,
  inout output: Array<usize>
): void throws String {
  if (tree.nodes[index].kind == ExpressionKind.closureExpression) return;
  if (tree.nodes[index].kind == ExpressionKind.tryExpression) {
    if (!includeRoot) return;
    if (tree.nodes[index].children.length != 1) {
      throw "native nested try lowering received a malformed try expression";
    }
    const attempted = tree.nodes[index].children[0];
    try collectNestedTryExpressions(
      tree,
      attempted,
      true,
      inout output
    );
    output.push(index);
    return;
  }
  if (
    tree.nodes[index].kind == ExpressionKind.conditionalExpression
  ) {
    if (tree.nodes[index].children.length != 3) {
      throw "native nested try lowering received a malformed conditional expression";
    }
    const condition = tree.nodes[index].children[0];
    const thenBranch = tree.nodes[index].children[1];
    const elseBranch = tree.nodes[index].children[2];
    try collectNestedTryExpressions(
      tree,
      condition,
      true,
      inout output
    );
    if (
      expressionTreeContainsTry(tree, thenBranch)
      || expressionTreeContainsTry(tree, elseBranch)
    ) output.push(index);
    return;
  }
  if (tree.nodes[index].kind == ExpressionKind.ifExpression) {
    if (expressionTreeContainsTry(tree, index)) {
      throw `native nested try propagation inside a value-if branch at ${tree.nodes[index].line}:${tree.nodes[index].column} still requires value-if branch-result normalization`;
    }
    return;
  }
  for (const child of tree.nodes[index].children) {
    try collectNestedTryExpressions(tree, child, true, inout output);
  }
}

function appendNestedConditionalBranch(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in arena: StatementArena,
  in ownerName: String,
  in tree: ExpressionTree,
  branchInput: usize,
  in destinationName: String,
  in destinationType: LoweredType,
  inout expressions: Array<LoweredExpression>,
  inout statements: Array<LoweredStatement>
): usize throws String {
  let branchRoots = Array<usize>();
  try appendNestedTryPreludeTree(
    program,
    importedTypes,
    evidence,
    arena,
    ownerName,
    tree,
    branchInput,
    true,
    inout expressions,
    inout statements,
    inout branchRoots
  );
  const expectedTypeName = loweredTypeIdentity(destinationType);
  let branchValue = try lowerExpressionExpected(
    program,
    importedTypes,
    evidence,
    tree,
    branchInput,
    expectedTypeName,
    inout expressions
  );
  branchValue = wrapImplicitOwnedTransfer(
    tree,
    branchInput,
    branchValue,
    inout expressions
  );
  if (
    moduleTypeNeedsCleanup(program, importedTypes, destinationType)
    && expressions[branchValue].kind == LoweredExpressionKind.localValue
    && (
      expressionHasLabel(
        expressions[branchValue],
        "nested-try-binding"
      )
      || expressionHasLabel(
        expressions[branchValue],
        "nested-conditional-binding"
      )
    )
  ) {
    let moveChildren = Array<usize>();
    moveChildren.push(branchValue);
    branchValue = pushExpression(
      inout expressions,
      LoweredExpressionKind.moveValue,
      "",
      move moveChildren,
      Array<String>()
    );
  }
  const destination = pushExpression(
    inout expressions,
    LoweredExpressionKind.localValue,
    destinationName,
    Array<usize>(),
    Array<String>()
  );
  const assignment = statements.length;
  statements.push(LoweredStatement({
    kind: LoweredStatementKind.assignmentStatement,
    mutableBinding: false,
    name: "",
    type: Option<LoweredType>.none,
    expression: Option.some(destination),
    secondExpression: Option.some(branchValue),
    children: Array<usize>(),
    cleanups: Array<LoweredCleanup>(),
    liveFlag: "",
    labels: Array<String>(),
    matchConsumesSubject: false,
    matchBindingNeedsCleanup: false,
  }));
  for (const branchPrelude of branchRoots) {
    if (
      nestedTryBindingWasTransferred(
        expressions,
        statements[branchPrelude].name
      )
    ) statements[branchPrelude].labels.push("transferred");
  }
  branchRoots.push(assignment);
  let blockLabels = Array<String>();
  blockLabels.push("nested-conditional-branch");
  const block = statements.length;
  statements.push(LoweredStatement({
    kind: LoweredStatementKind.blockStatement,
    mutableBinding: false,
    name: "",
    type: Option<LoweredType>.none,
    expression: Option<usize>.none,
    secondExpression: Option<usize>.none,
    children: move branchRoots,
    cleanups: Array<LoweredCleanup>(),
    liveFlag: "",
    labels: move blockLabels,
    matchConsumesSubject: false,
    matchBindingNeedsCleanup: false,
  }));
  return block;
}

function appendNestedConditionalPrelude(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in arena: StatementArena,
  in ownerName: String,
  in tree: ExpressionTree,
  index: usize,
  inout expressions: Array<LoweredExpression>,
  inout statements: Array<LoweredStatement>,
  inout roots: Array<usize>
): void throws String {
  if (tree.nodes[index].children.length != 3) {
    throw "native nested conditional lowering received a malformed expression";
  }
  const conditionInput = tree.nodes[index].children[0];
  const thenInput = tree.nodes[index].children[1];
  const elseInput = tree.nodes[index].children[2];
  const destinationTypeName = match (staticallyResolvedExpressionTypeName(
    program,
    importedTypes,
    evidence,
    arena,
    ownerName,
    tree,
    index
  )) {
    some(name) => name;
    none => throw `native nested conditional lowering could not resolve its result type at ${tree.nodes[index].line}:${tree.nodes[index].column}`;
  };
  const destinationType = try lowerModuleTypeName(
    program,
    importedTypes,
    destinationTypeName
  );
  const destinationName = `_z_stage1_nested_conditional_${tree.nodes[index].offset}`;
  let bindingLabels = Array<String>();
  bindingLabels.push("nested-conditional-binding");
  pushExpression(
    inout expressions,
    LoweredExpressionKind.localValue,
    destinationName,
    Array<usize>(),
    move bindingLabels
  );
  const condition = try lowerExpression(
    program,
    importedTypes,
    evidence,
    tree,
    conditionInput,
    inout expressions
  );
  const thenBranch = try appendNestedConditionalBranch(
    program,
    importedTypes,
    evidence,
    arena,
    ownerName,
    tree,
    thenInput,
    destinationName,
    destinationType,
    inout expressions,
    inout statements
  );
  const elseBranch = try appendNestedConditionalBranch(
    program,
    importedTypes,
    evidence,
    arena,
    ownerName,
    tree,
    elseInput,
    destinationName,
    destinationType,
    inout expressions,
    inout statements
  );
  let ifChildren = Array<usize>();
  ifChildren.push(thenBranch);
  ifChildren.push(elseBranch);
  let ifLabels = Array<String>();
  ifLabels.push("nested-conditional-if");
  const loweredIf = statements.length;
  statements.push(LoweredStatement({
    kind: LoweredStatementKind.ifStatement,
    mutableBinding: false,
    name: "",
    type: Option<LoweredType>.none,
    expression: Option.some(condition),
    secondExpression: Option<usize>.none,
    children: move ifChildren,
    cleanups: Array<LoweredCleanup>(),
    liveFlag: "",
    labels: move ifLabels,
    matchConsumesSubject: false,
    matchBindingNeedsCleanup: false,
  }));
  let localChildren = Array<usize>();
  localChildren.push(loweredIf);
  let localLabels = Array<String>();
  localLabels.push("nested-conditional");
  const local = statements.length;
  statements.push(LoweredStatement({
    kind: LoweredStatementKind.localStatement,
    mutableBinding: true,
    name: move destinationName,
    type: Option.some(move destinationType),
    expression: Option<usize>.none,
    secondExpression: Option<usize>.none,
    children: move localChildren,
    cleanups: Array<LoweredCleanup>(),
    liveFlag: "",
    labels: move localLabels,
    matchConsumesSubject: false,
    matchBindingNeedsCleanup: false,
  }));
  roots.push(local);
}

function appendNestedTryPreludeTree(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in arena: StatementArena,
  in ownerName: String,
  in tree: ExpressionTree,
  root: usize,
  includeRoot: boolean,
  inout expressions: Array<LoweredExpression>,
  inout statements: Array<LoweredStatement>,
  inout roots: Array<usize>
): void throws String {
  let nested = Array<usize>();
  try collectNestedTryExpressions(
    tree,
    root,
    includeRoot,
    inout nested
  );
  if (nested.length == 0) return;
  const outerResult = try throwingFunctionResult(
        program,
        importedTypes,
        ownerName
      );
      const outer = match (outerResult) {
        some(declaration) => declaration;
        none => throw "native nested try lowering requires an enclosing throwing function";
  };
  for (const nestedTry of nested) {
    if (
      tree.nodes[nestedTry].kind
        == ExpressionKind.conditionalExpression
    ) {
      try appendNestedConditionalPrelude(
        program,
        importedTypes,
        evidence,
        arena,
        ownerName,
        tree,
        nestedTry,
        inout expressions,
        inout statements,
        inout roots
      );
      continue;
    }
        const attempted = tree.nodes[nestedTry].children[0];
        const successTypeName = match (staticallyResolvedExpressionTypeName(
          program,
          importedTypes,
          evidence,
          arena,
          ownerName,
          tree,
          nestedTry
        )) {
          some(name) => name;
          none => throw `native nested try lowering could not resolve its success type at ${tree.nodes[nestedTry].line}:${tree.nodes[nestedTry].column}`;
        };
        const successType = try lowerModuleTypeName(
          program,
          importedTypes,
          successTypeName
        );
        const directResult = try directThrowingCallResult(
          program,
          importedTypes,
          evidence,
          tree,
          attempted,
          ownerName
        );
        const innerResult: Option<LoweredEnum> = match (directResult) {
          some(declaration) => Option<LoweredEnum>.some(move declaration);
          none => awaitedResultForSuccessType(
            program,
            importedTypes,
            tree,
            attempted,
            successType,
            outer
          );
        };
        const inner = match (innerResult) {
          some(declaration) => declaration;
          none => throw "native nested try lowering requires one direct throwing call or fallible task await";
        };
        const attemptedValue = try lowerExpression(
          program,
          importedTypes,
          evidence,
          tree,
          attempted,
          inout expressions
        );
        const bindingName = `_z_stage1_nested_try_${tree.nodes[nestedTry].offset}`;
        let bindingLabels = Array<String>();
        bindingLabels.push("nested-try-binding");
        pushExpression(
          inout expressions,
          LoweredExpressionKind.localValue,
          bindingName,
          Array<usize>(),
          move bindingLabels
        );
        let tryLabels = Array<String>();
        tryLabels.push(bindingName.copyBytes(0, bindingName.byteLength));
        tryLabels.push(outer.name.copyBytes(0, outer.name.byteLength));
        const loweredTry = statements.length;
        statements.push(LoweredStatement({
          kind: LoweredStatementKind.tryStatement,
          mutableBinding: false,
          name: inner.name.copyBytes(0, inner.name.byteLength),
          type: Option.some(LoweredType({
            kind: successType.kind,
            name: successType.name.copyBytes(0, successType.name.byteLength),
          })),
          expression: Option.some(attemptedValue),
          secondExpression: Option<usize>.none,
          children: Array<usize>(),
          cleanups: Array<LoweredCleanup>(),
          liveFlag: "",
          labels: tryLabels,
          matchConsumesSubject: false,
          matchBindingNeedsCleanup: false,
        }));
        let localChildren = Array<usize>();
        localChildren.push(loweredTry);
        let localLabels = Array<String>();
        localLabels.push("nested-try");
        const local = statements.length;
        statements.push(LoweredStatement({
          kind: LoweredStatementKind.localStatement,
          mutableBinding: true,
          name: move bindingName,
          type: Option.some(move successType),
          expression: Option<usize>.none,
          secondExpression: Option<usize>.none,
          children: move localChildren,
          cleanups: Array<LoweredCleanup>(),
          liveFlag: "",
          labels: move localLabels,
          matchConsumesSubject: false,
          matchBindingNeedsCleanup: false,
        }));
    roots.push(local);
  }
}

function appendNestedTryPreludeRoots(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in arena: StatementArena,
  in ownerName: String,
  in syntax: ExpressionSyntax,
  includeRoot: boolean,
  inout expressions: Array<LoweredExpression>,
  inout statements: Array<LoweredStatement>,
  inout roots: Array<usize>
): void throws String {
  match (in syntax.tree) {
    some(tree) => {
      const root = tree.root;
      try appendNestedTryPreludeTree(
        program,
        importedTypes,
        evidence,
        arena,
        ownerName,
        tree,
        root,
        includeRoot,
        inout expressions,
        inout statements,
        inout roots
      );
    }
    none => {}
  }
}

function loweredExpressionDirectlyConsumesChild(
  in expressions: Array<LoweredExpression>,
  parent: usize,
  childPosition: usize
): boolean {
  if (expressions[parent].kind == LoweredExpressionKind.moveValue) return true;
  if (
    expressions[parent].kind == LoweredExpressionKind.structValue
    || expressions[parent].kind == LoweredExpressionKind.classValue
    || expressions[parent].kind == LoweredExpressionKind.enumPayloadValue
    || expressions[parent].kind == LoweredExpressionKind.mutexValue
    || expressions[parent].kind == LoweredExpressionKind.onceInitialize
  ) return true;
  if (
    expressions[parent].kind == LoweredExpressionKind.directCall
    && childPosition > 0
    && expressions[parent].labels.length >= childPosition
  ) return expressions[parent].labels[childPosition - 1] == "value";
  if (expressions[parent].kind == LoweredExpressionKind.methodCall) {
    if (
      childPosition == 0
      && expressions[parent].labels.length > 1
    ) return expressions[parent].labels[1] == "move";
    if (
      childPosition > 0
      && expressions[parent].labels.length > childPosition + 1
    ) return expressions[parent].labels[childPosition + 1] == "value";
  }
  return false;
}

function nestedTryBindingWasTransferred(
  in expressions: Array<LoweredExpression>,
  in name: String
): boolean {
  let parent: usize = 0;
  while (parent < expressions.length) {
    let childPosition: usize = 0;
    while (childPosition < expressions[parent].children.length) {
      const child = expressions[parent].children[childPosition];
      if (
        expressions[child].kind == LoweredExpressionKind.localValue
        && expressions[child].value == name
        && loweredExpressionDirectlyConsumesChild(
          expressions,
          parent,
          childPosition
        )
      ) return true;
      childPosition = childPosition + 1;
    }
    parent = parent + 1;
  }
  return false;
}

function loweredStatementDirectlyTransfersBinding(
  in expressions: Array<LoweredExpression>,
  in statements: Array<LoweredStatement>,
  index: usize,
  in name: String
): boolean {
  let value = Option<usize>.none;
  if (statements[index].kind == LoweredStatementKind.localStatement) {
    match (in statements[index].expression) {
      some(expression) => value = Option.some(expression);
      none => {}
    }
  } else if (
    statements[index].kind == LoweredStatementKind.assignmentStatement
  ) {
    match (in statements[index].secondExpression) {
      some(expression) => value = Option.some(expression);
      none => {}
    }
  }
  match (value) {
    some(expression) => {
      if (
        expressions[expression].kind == LoweredExpressionKind.localValue
        && expressions[expression].value == name
      ) return true;
      if (
        expressions[expression].kind == LoweredExpressionKind.moveValue
        && expressions[expression].children.length == 1
      ) {
        const child = expressions[expression].children[0];
        return expressions[child].kind == LoweredExpressionKind.localValue
          && expressions[child].value == name;
      }
    }
    none => {}
  }
  return false;
}

function lowerStatement(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in arena: StatementArena,
  in ownerName: String,
  index: usize,
  inout expressions: Array<LoweredExpression>,
  inout statements: Array<LoweredStatement>
): usize throws String {
  let preludeRoots = Array<usize>();
  match (in arena.nodes[index].expression) {
    some(syntax) => {
      let includeRoot = true;
      match (in syntax.tree) {
        some(tree) => {
          if (
            tree.nodes[tree.root].kind == ExpressionKind.tryExpression
            && (
              arena.nodes[index].kind == StatementKind.variableStatement
              || arena.nodes[index].kind == StatementKind.expressionStatement
              || arena.nodes[index].kind == StatementKind.returnStatement
            )
          ) includeRoot = false;
        }
        none => {}
      }
      try appendNestedTryPreludeRoots(
        program,
        importedTypes,
        evidence,
        arena,
        ownerName,
        syntax,
        includeRoot,
        inout expressions,
        inout statements,
        inout preludeRoots
      );
    }
    none => {}
  }
  match (in arena.nodes[index].secondExpression) {
    some(syntax) => {
      let includeRoot = true;
      match (in syntax.tree) {
        some(tree) => {
          if (
            tree.nodes[tree.root].kind == ExpressionKind.tryExpression
            && arena.nodes[index].kind == StatementKind.assignmentStatement
          ) includeRoot = false;
        }
        none => {}
      }
      try appendNestedTryPreludeRoots(
        program,
        importedTypes,
        evidence,
        arena,
        ownerName,
        syntax,
        includeRoot,
        inout expressions,
        inout statements,
        inout preludeRoots
      );
    }
    none => {}
  }
  if (preludeRoots.length == 0) {
    return try lowerStatementCore(
      program,
      importedTypes,
      evidence,
      arena,
      ownerName,
      index,
      inout expressions,
      inout statements
    );
  }
  const lowered = try lowerStatementCore(
    program,
    importedTypes,
    evidence,
    arena,
    ownerName,
    index,
    inout expressions,
    inout statements
  );
  for (const prelude of preludeRoots) {
    if (
      nestedTryBindingWasTransferred(
        expressions,
        statements[prelude].name
      )
      || loweredStatementDirectlyTransfersBinding(
        expressions,
        statements,
        lowered,
        statements[prelude].name
      )
    ) statements[prelude].labels.push("transferred");
  }
  preludeRoots.push(lowered);
  let labels = Array<String>();
  labels.push("nested-try-normalized");
  const block = statements.length;
  statements.push(LoweredStatement({
    kind: LoweredStatementKind.blockStatement,
    mutableBinding: false,
    name: "",
    type: Option<LoweredType>.none,
    expression: Option<usize>.none,
    secondExpression: Option<usize>.none,
    children: move preludeRoots,
    cleanups: Array<LoweredCleanup>(),
    liveFlag: "",
    labels: move labels,
    matchConsumesSubject: false,
    matchBindingNeedsCleanup: false,
  }));
  return block;
}

function lowerStatementCore(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in arena: StatementArena,
  in ownerName: String,
  index: usize,
  inout expressions: Array<LoweredExpression>,
  inout statements: Array<LoweredStatement>
): usize throws String {
  if (arena.nodes[index].kind == StatementKind.expressionStatement) {
    match (in arena.nodes[index].expression) {
      some(syntax) => match (in syntax.tree) {
        some(tree) => {
          const root = tree.root;
          if (
            tree.nodes[root].kind == ExpressionKind.awaitExpression
            && tree.nodes[root].children.length == 1
          ) {
            const operation = tree.nodes[root].children[0];
            if (
              tree.nodes[operation].kind == ExpressionKind.callExpression
              && tree.nodes[operation].children.length == 1
            ) {
              const callee = tree.nodes[operation].children[0];
              if (
                tree.nodes[callee].kind == ExpressionKind.memberExpression
                && tree.nodes[callee].value == "cancel"
                && tree.nodes[callee].children.length == 1
              ) {
                const receiver = tree.nodes[callee].children[0];
                const receiverTypeName = match (
                  staticallyResolvedExpressionTypeName(
                    program,
                    importedTypes,
                    evidence,
                    arena,
                    ownerName,
                    tree,
                    receiver
                  )
                ) {
                  some(name) => name;
                  none => throw "native task cancellation could not resolve its Task type";
                };
                const storageType = try taskStorageType(
                  program,
                  importedTypes,
                  receiverTypeName
                );
                const loweredReceiver = try lowerExpression(
                  program,
                  importedTypes,
                  evidence,
                  tree,
                  receiver,
                  inout expressions
                );
                let cancelChildren = Array<usize>();
                cancelChildren.push(loweredReceiver);
                const taskName = intrinsicTaskName(storageType);
                const cancellation = pushExpression(
                  inout expressions,
                  LoweredExpressionKind.threadCancel,
                  taskName,
                  cancelChildren,
                  Array<String>()
                );
                const lowered = statements.length;
                statements.push(LoweredStatement({
                  kind: LoweredStatementKind.expressionStatement,
                  mutableBinding: false,
                  name: "",
                  type: Option<LoweredType>.none,
                  expression: Option.some(cancellation),
                  secondExpression: Option<usize>.none,
                  children: Array<usize>(),
                  cleanups: Array<LoweredCleanup>(),
                  liveFlag: "",
                  labels: Array<String>(),
                  matchConsumesSubject: false,
                  matchBindingNeedsCleanup: false,
                }));
                return lowered;
              }
            }
          }
          if (
            tree.nodes[root].kind == ExpressionKind.callExpression
            && tree.nodes[root].children.length == 2
          ) {
            const callee = tree.nodes[root].children[0];
            const failName = standardTestBindingName(program, "fail");
            if (
              failName.byteLength > 0
              && tree.nodes[callee].kind == ExpressionKind.identifierExpression
              && tree.nodes[callee].value == failName
            ) {
              const messageArgument = tree.nodes[root].children[1];
              const messageInput = testBorrowInput(
                tree,
                messageArgument
              );
              const message = try lowerExpression(
                program,
                importedTypes,
                evidence,
                tree,
                messageInput,
                inout expressions
              );
              const resultOutcome = try throwingFunctionResult(
                program,
                importedTypes,
                ownerName
              );
              const result = match (resultOutcome) {
                some(declaration) => declaration;
                none => throw "native test failure lowering requires a throwing test body";
              };
              let children = Array<usize>();
              children.push(message);
              let labels = Array<String>();
              labels.push("failure");
              const failure = pushExpression(
                inout expressions,
                LoweredExpressionKind.enumPayloadValue,
                result.name,
                children,
                labels
              );
              const lowered = statements.length;
              statements.push(LoweredStatement({
                kind: LoweredStatementKind.returnStatement,
                mutableBinding: false,
                name: "",
                type: Option<LoweredType>.none,
                expression: Option.some(failure),
                secondExpression: Option<usize>.none,
                children: Array<usize>(),
                cleanups: Array<LoweredCleanup>(),
                liveFlag: "",
                labels: Array<String>(),
                matchConsumesSubject: false,
                matchBindingNeedsCleanup: false,
              }));
              return lowered;
            }

            if (
              tree.nodes[callee].kind == ExpressionKind.memberExpression
              && tree.nodes[callee].value == "toEqual"
              && tree.nodes[callee].children.length == 1
            ) {
              const expectation = tree.nodes[callee].children[0];
              if (
                tree.nodes[expectation].kind == ExpressionKind.callExpression
                && tree.nodes[expectation].children.length == 2
              ) {
                const expectCallee = tree.nodes[expectation].children[0];
                const expectName = standardTestBindingName(program, "expect");
                if (
                  expectName.byteLength > 0
                  && tree.nodes[expectCallee].kind
                    == ExpressionKind.identifierExpression
                  && tree.nodes[expectCallee].value == expectName
                ) {
                  const actualArgument =
                    tree.nodes[expectation].children[1];
                  const expectedArgument = tree.nodes[root].children[1];
                  const actualInput = testBorrowInput(
                    tree,
                    actualArgument
                  );
                  const expectedInput = testBorrowInput(
                    tree,
                    expectedArgument
                  );
                  const actualType = match (testExpressionTypeName(
                    program,
                    importedTypes,
                    evidence,
                    arena,
                    ownerName,
                    tree,
                    actualInput,
                    ""
                  )) {
                    some(name) => name;
                    none => {
                      const actualKind = expressionKindName(
                        tree.nodes[actualInput].kind
                      );
                      throw `native test expectation lowering could not resolve the ${actualKind} actual value type at ${tree.nodes[actualInput].line}:${tree.nodes[actualInput].column}`;
                    }
                  };
                  const expectedType = match (testExpressionTypeName(
                    program,
                    importedTypes,
                    evidence,
                    arena,
                    ownerName,
                    tree,
                    expectedInput,
                    actualType
                  )) {
                    some(name) => name;
                    none => {
                      const expectedKind = expressionKindName(
                        tree.nodes[expectedInput].kind
                      );
                      throw `native test expectation lowering could not resolve the ${expectedKind} expected value type at ${tree.nodes[expectedInput].line}:${tree.nodes[expectedInput].column}`;
                    }
                  };
                  let actualValueType = actualType.copyBytes(
                    0,
                    actualType.byteLength
                  );
                  if (
                    stringStartsWith(actualValueType, "view ")
                    && actualValueType.byteLength > 5
                  ) {
                    actualValueType = actualValueType.copyBytes(
                      5,
                      actualValueType.byteLength
                    );
                  }
                  let expectedValueType = expectedType.copyBytes(
                    0,
                    expectedType.byteLength
                  );
                  if (
                    stringStartsWith(expectedValueType, "view ")
                    && expectedValueType.byteLength > 5
                  ) {
                    expectedValueType = expectedValueType.copyBytes(
                      5,
                      expectedValueType.byteLength
                    );
                  }
                  let comparison = "scalar";
                  if (
                    actualValueType == "String"
                    && expectedValueType == "String"
                  ) {
                    comparison = "string";
                  } else {
                    const comparableType = try lowerModuleTypeName(
                      program,
                      importedTypes,
                      actualValueType
                    );
                    if (comparableType.kind == LoweredTypeKind.enumType) {
                      comparison = "enum";
                    } else if (
                      comparableType.kind == LoweredTypeKind.foreignEnumType
                    ) {
                      comparison = "foreignEnum";
                    }
                  }
                  if (
    actualValueType != "String"
    && actualValueType != "boolean"
    && actualValueType != "i8"
    && actualValueType != "i16"
    && actualValueType != "i32"
    && actualValueType != "i64"
    && actualValueType != "isize"
    && actualValueType != "u8"
    && actualValueType != "u16"
    && actualValueType != "u32"
    && actualValueType != "u64"
    && actualValueType != "usize"
    && actualValueType != "f32"
    && actualValueType != "f64"
                    && comparison != "enum"
                    && comparison != "foreignEnum"
                  ) {
                    throw `native test failure formatting does not support ${actualValueType} yet`;
                  }
                  const actual = try lowerExpression(
                    program,
                    importedTypes,
                    evidence,
                    tree,
                    actualInput,
                    inout expressions
                  );
                  const expected = try lowerExpressionExpected(
                    program,
                    importedTypes,
                    evidence,
                    tree,
                    expectedInput,
                    actualType,
                    inout expressions
                  );
                  let labels = Array<String>();
                  labels.push(actualType);
                  labels.push(expectedType);
                  labels.push(comparison);
                  labels.push(`${arena.nodes[index].line}`);
                  labels.push(`${arena.nodes[index].column}`);
                  const lowered = statements.length;
                  statements.push(LoweredStatement({
                    kind: LoweredStatementKind.testExpectationStatement,
                    mutableBinding: false,
                    name: "",
                    type: Option<LoweredType>.none,
                    expression: Option.some(actual),
                    secondExpression: Option.some(expected),
                    children: Array<usize>(),
                    cleanups: Array<LoweredCleanup>(),
                    liveFlag: "",
                    labels,
                    matchConsumesSubject: false,
                    matchBindingNeedsCleanup: false,
                  }));
                  return lowered;
                }
              }
            }
          }
        }
        none => {}
      }
      none => {}
    }
  }
  if (arena.nodes[index].kind == StatementKind.assignmentStatement) {
    match (in arena.nodes[index].secondExpression) {
      some(syntax) => match (in syntax.tree) {
        some(tree) => {
          const root = tree.root;
          if (
            tree.nodes[root].kind == ExpressionKind.tryExpression
            && tree.nodes[root].children.length == 1
          ) {
            const attempted = tree.nodes[root].children[0];
            const innerResult = try directThrowingCallResult(
              program,
              importedTypes,
              evidence,
              tree,
              attempted,
              ownerName
            );
            const inner = match (innerResult) {
              some(declaration) => declaration;
              none => throw "native assignment try lowering requires one direct throwing function call";
            };
            const outerResult = try throwingFunctionResult(
              program,
              importedTypes,
              ownerName
            );
            const outer = match (outerResult) {
              some(declaration) => declaration;
              none => throw "native assignment try lowering requires an enclosing throwing function";
            };
            let targetName = "";
            let targetTypeName = "";
            let targetExpression = Option<usize>.none;
            match (in arena.nodes[index].expression) {
              some(targetSyntax) => match (in targetSyntax.tree) {
                some(targetTree) => {
                  const targetRoot = targetTree.root;
                  if (
                    targetTree.nodes[targetRoot].kind
                      == ExpressionKind.identifierExpression
                  ) {
                    targetName = targetTree.nodes[targetRoot].value.copyBytes(
                      0,
                      targetTree.nodes[targetRoot].value.byteLength
                    );
                  } else {
                    targetName = "target";
                  }
                  match (matchSubjectTypeName(
                    program,
                    importedTypes,
                    evidence,
                    arena,
                    ownerName,
                    targetTree,
                    targetRoot
                  )) {
                    some(name) => targetTypeName = move name;
                    none => {}
                  }
                  const loweredTarget = try lowerExpression(
                    program,
                    importedTypes,
                    evidence,
                    targetTree,
                    targetRoot,
                    inout expressions
                  );
                  markMutableStorage(inout expressions, loweredTarget);
                  targetExpression = Option.some(loweredTarget);
                }
                none => {}
              }
              none => {}
            }
            if (targetName.byteLength == 0) {
              throw "native assignment try lowering requires a named target";
            }
            if (targetTypeName.byteLength == 0) {
              throw `native assignment try lowering could not resolve ${targetName}`;
            }
            const targetType = try lowerModuleTypeName(
              program,
              importedTypes,
              targetTypeName
            );
            const replacesOwner = moduleTypeNeedsCleanup(
              program,
              importedTypes,
              targetType
            );
            const call = try lowerExpression(
              program,
              importedTypes,
              evidence,
              tree,
              attempted,
              inout expressions
            );
            let labels = Array<String>();
            labels.push(move targetName);
            labels.push(outer.name.copyBytes(0, outer.name.byteLength));
            if (replacesOwner) labels.push("replace");
            const loweredTry = statements.length;
            statements.push(LoweredStatement({
              kind: LoweredStatementKind.tryStatement,
              mutableBinding: false,
              name: inner.name.copyBytes(0, inner.name.byteLength),
              type: Option.some(move targetType),
              expression: Option.some(call),
              secondExpression: targetExpression,
              children: Array<usize>(),
              cleanups: Array<LoweredCleanup>(),
              liveFlag: "",
              labels,
              matchConsumesSubject: false,
              matchBindingNeedsCleanup: false,
            }));
            return loweredTry;
          }
        }
        none => {}
      }
      none => {}
    }
  }
  if (arena.nodes[index].kind == StatementKind.expressionStatement) {
    match (in arena.nodes[index].expression) {
      some(syntax) => {
        match (in syntax.tree) {
          some(tree) => {
            const root = tree.root;
            if (
              tree.nodes[root].kind == ExpressionKind.tryExpression
              && tree.nodes[root].children.length == 1
            ) {
              const attempted = tree.nodes[root].children[0];
              const innerResult = try directThrowingCallResult(
                program,
                importedTypes,
                evidence,
                tree,
                attempted,
                ownerName
              );
              const inner = match (innerResult) {
                some(declaration) => declaration;
                none => throw "native try lowering requires one direct throwing function call yet";
              };
              let successType = LoweredType({
                kind: LoweredTypeKind.voidType,
                name: "",
              });
              for (const variant of inner.variants) {
                if (variant.name != "success") continue;
                match (in variant.payload) {
                  some(payload) => successType = LoweredType({
                    kind: payload.kind,
                    name: payload.name.copyBytes(0, payload.name.byteLength),
                  });
                  none => {}
                }
              }
              const outerResult = try throwingFunctionResult(
                program,
                importedTypes,
                ownerName
              );
              const outer = match (outerResult) {
                some(declaration) => declaration;
                none => throw "native try lowering requires an enclosing throwing function";
              };
              const call = try lowerExpression(
                program,
                importedTypes,
                evidence,
                tree,
                attempted,
                inout expressions
              );
              let labels = Array<String>();
              labels.push("");
              labels.push(outer.name.copyBytes(0, outer.name.byteLength));
              const loweredTry = statements.length;
              statements.push(LoweredStatement({
                kind: LoweredStatementKind.tryStatement,
                mutableBinding: false,
                name: inner.name.copyBytes(0, inner.name.byteLength),
                type: Option.some(move successType),
                expression: Option.some(call),
                secondExpression: Option<usize>.none,
                children: Array<usize>(),
                cleanups: Array<LoweredCleanup>(),
                liveFlag: "",
                labels,
                matchConsumesSubject: false,
                matchBindingNeedsCleanup: false,
              }));
              return loweredTry;
            }
          }
          none => {}
        }
      }
      none => {}
    }
  }
  if (arena.nodes[index].kind == StatementKind.variableStatement) {
    match (in arena.nodes[index].expression) {
      some(syntax) => {
        match (in syntax.tree) {
          some(tree) => {
            const root = tree.root;
            if (
              tree.nodes[root].kind == ExpressionKind.tryExpression
              && tree.nodes[root].children.length == 1
            ) {
              const attempted = tree.nodes[root].children[0];
              const outerResult = try throwingFunctionResult(
                program,
                importedTypes,
                ownerName
              );
              const outer = match (outerResult) {
                some(declaration) => declaration;
                none => throw "native try lowering requires an enclosing throwing function";
              };
              const bindingType = try lowerBindingType(
                program,
                importedTypes,
                evidence,
                arena,
                ownerName,
                index
              );
              const directResult = try directThrowingCallResult(
                program,
                importedTypes,
                evidence,
                tree,
                attempted,
                ownerName
              );
              const innerResult: Option<LoweredEnum> = match (directResult) {
                some(declaration) => Option<LoweredEnum>.some(move declaration);
                none => awaitedResultForSuccessType(
                  program,
                  importedTypes,
                  tree,
                  attempted,
                  bindingType,
                  outer
                );
              };
              const inner = match (innerResult) {
                some(declaration) => declaration;
                none => throw "native try lowering requires one direct throwing function call or fallible task await yet";
              };
              const call = try lowerExpression(
                program,
                importedTypes,
                evidence,
                tree,
                attempted,
                inout expressions
              );
              let tryLabels = Array<String>();
              tryLabels.push(arena.nodes[index].name.copyBytes(
                0,
                arena.nodes[index].name.byteLength
              ));
              tryLabels.push(outer.name.copyBytes(0, outer.name.byteLength));
              const loweredTry = statements.length;
              statements.push(LoweredStatement({
                kind: LoweredStatementKind.tryStatement,
                mutableBinding: false,
                name: inner.name.copyBytes(0, inner.name.byteLength),
                type: Option.some(LoweredType({
                  kind: bindingType.kind,
                  name: bindingType.name.copyBytes(0, bindingType.name.byteLength),
                })),
                expression: Option.some(call),
                secondExpression: Option<usize>.none,
                children: Array<usize>(),
                cleanups: Array<LoweredCleanup>(),
                liveFlag: "",
                labels: tryLabels,
                matchConsumesSubject: false,
                matchBindingNeedsCleanup: false,
              }));
              let children = Array<usize>();
              children.push(loweredTry);
              const localIndex = statements.length;
              statements.push(LoweredStatement({
                kind: LoweredStatementKind.localStatement,
                mutableBinding: arena.nodes[index].mutableBinding,
                name: arena.nodes[index].name.copyBytes(
                  0,
                  arena.nodes[index].name.byteLength
                ),
                type: Option.some(move bindingType),
                expression: Option<usize>.none,
                secondExpression: Option<usize>.none,
                children,
                cleanups: Array<LoweredCleanup>(),
                liveFlag: "",
                labels: Array<String>(),
                matchConsumesSubject: false,
                matchBindingNeedsCleanup: false,
              }));
              return localIndex;
            }
          }
          none => {}
        }
      }
      none => {}
    }
  }
  if (
    arena.nodes[index].kind == StatementKind.matchStatement
    || arena.nodes[index].kind == StatementKind.returnStatement
    || arena.nodes[index].kind == StatementKind.variableStatement
  ) {
    match (in arena.nodes[index].expression) {
      some(syntax) => {
        match (in syntax.tree) {
          some(tree) => {
            const root = tree.root;
            if (tree.nodes[root].kind == ExpressionKind.matchExpression) {
              const valueBinding = arena.nodes[index].kind
                == StatementKind.variableStatement
                ? arena.nodes[index].name.copyBytes(
                  0,
                  arena.nodes[index].name.byteLength
                )
                : "";
              const loweredMatch = try lowerMatchTree(
                program,
                importedTypes,
                evidence,
                arena,
                ownerName,
                tree,
                root,
                arena.nodes[index].kind == StatementKind.returnStatement,
                valueBinding,
                inout expressions,
                inout statements
              );
              if (arena.nodes[index].kind != StatementKind.variableStatement) {
                return loweredMatch;
              }
              const bindingType = try lowerBindingType(
                program,
                importedTypes,
                evidence,
                arena,
                ownerName,
                index
              );
              let children = Array<usize>();
              children.push(loweredMatch);
              const localIndex = statements.length;
              statements.push(LoweredStatement({
                kind: LoweredStatementKind.localStatement,
                mutableBinding: arena.nodes[index].mutableBinding,
                name: arena.nodes[index].name.copyBytes(
                  0,
                  arena.nodes[index].name.byteLength
                ),
                type: Option.some(move bindingType),
                expression: Option<usize>.none,
                secondExpression: Option<usize>.none,
                children,
                cleanups: Array<LoweredCleanup>(),
                liveFlag: "",
                labels: Array<String>(),
                matchConsumesSubject: false,
                matchBindingNeedsCleanup: false,
              }));
              return localIndex;
            }
          }
          none => {}
        }
      }
      none => {}
    }
  }
  let kind = LoweredStatementKind.expressionStatement;
  if (arena.nodes[index].kind == StatementKind.variableStatement) {
    kind = LoweredStatementKind.localStatement;
  } else if (arena.nodes[index].kind == StatementKind.assignmentStatement) {
    kind = LoweredStatementKind.assignmentStatement;
  } else if (arena.nodes[index].kind == StatementKind.returnStatement) {
    kind = LoweredStatementKind.returnStatement;
  } else if (arena.nodes[index].kind == StatementKind.throwStatement) {
    kind = LoweredStatementKind.returnStatement;
  } else if (arena.nodes[index].kind == StatementKind.expressionStatement) {
    kind = LoweredStatementKind.expressionStatement;
  } else if (arena.nodes[index].kind == StatementKind.blockStatement) {
    kind = LoweredStatementKind.blockStatement;
  } else if (arena.nodes[index].kind == StatementKind.ifStatement) {
    kind = LoweredStatementKind.ifStatement;
  } else if (arena.nodes[index].kind == StatementKind.whileStatement) {
    kind = LoweredStatementKind.whileStatement;
  } else if (arena.nodes[index].kind == StatementKind.forStatement) {
    if (arena.nodes[index].mutableBinding) {
      throw "native lowering does not support `for (const value of inout values)` yet";
    }
    if (
      arena.nodes[index].name.byteLength == 0
      || arena.nodes[index].objectBindings.length > 0
    ) {
      throw "native lowering does not support destructuring for bindings yet";
    }
    kind = LoweredStatementKind.forStatement;
  } else if (arena.nodes[index].kind == StatementKind.breakStatement) {
    kind = LoweredStatementKind.breakStatement;
  } else if (arena.nodes[index].kind == StatementKind.continueStatement) {
    kind = LoweredStatementKind.continueStatement;
  } else {
    const unsupportedKind = statementKindName(arena.nodes[index].kind);
    throw `native lowering does not support ${unsupportedKind} statement at ${arena.nodes[index].line}:${arena.nodes[index].column} in ${ownerName} yet`;
  }

  let type = Option<LoweredType>.none;
  if (arena.nodes[index].kind == StatementKind.variableStatement) {
    const loweredType = try lowerBindingType(
      program,
      importedTypes,
      evidence,
      arena,
      ownerName,
      index
    );
    type = Option.some(move loweredType);
  } else if (arena.nodes[index].kind == StatementKind.forStatement) {
    for (const binding of evidence.bindingResolutions) {
      if (
        binding.offset == arena.nodes[index].nameOffset
        && binding.name == arena.nodes[index].name
        && binding.typeName.byteLength > 0
      ) {
        const loweredType = try lowerModuleTypeName(
          program,
          importedTypes,
          binding.typeName
        );
        type = Option.some(move loweredType);
      }
    }
  } else {
    match (in arena.nodes[index].typeAnnotation) {
      some(annotation) => {
        const loweredType = try lowerModuleType(
          program,
          importedTypes,
          annotation
        );
        type = Option.some(move loweredType);
      }
      none => {}
    }
  }
  let expression = Option<usize>.none;
  match (in arena.nodes[index].expression) {
    some(source) => {
      const expressionStart = expressions.length;
      let directTryReturn = false;
      let loweredValue: usize = 0;
      if (arena.nodes[index].kind == StatementKind.returnStatement) {
        match (in source.tree) {
          some(tree) => {
            const root = tree.root;
            if (
              tree.nodes[root].kind == ExpressionKind.tryExpression
              && tree.nodes[root].children.length == 1
            ) {
              const attempted = tree.nodes[root].children[0];
              loweredValue = try lowerExpression(
                program,
                importedTypes,
                evidence,
                tree,
                attempted,
                inout expressions
              );
              directTryReturn = true;
            } else {
              let expectedTypeName = "";
              for (const declaration of program.functions) {
                if (declaration.name == ownerName) {
                  expectedTypeName = declaration.returnType.name.copyBytes(
                    0,
                    declaration.returnType.name.byteLength
                  );
                }
              }
              loweredValue = try lowerExpressionExpected(
                program,
                importedTypes,
                evidence,
                tree,
                root,
                expectedTypeName,
                inout expressions
              );
              if (
                tree.nodes[root].kind == ExpressionKind.identifierExpression
                && expressions[loweredValue].kind
                  != LoweredExpressionKind.moveValue
              ) {
                let moveChildren = Array<usize>();
                moveChildren.push(loweredValue);
                loweredValue = pushExpression(
                  inout expressions,
                  LoweredExpressionKind.moveValue,
                  "",
                  moveChildren,
                  Array<String>()
                );
              }
            }
          }
          none => throw "native lowering cannot lower an opaque expression";
        }
      } else {
        loweredValue = try lowerExpressionSyntax(
          program,
          importedTypes,
          evidence,
          source,
          inout expressions
        );
        if (arena.nodes[index].kind == StatementKind.assignmentStatement) {
          markMutableStorage(inout expressions, loweredValue);
        }
        if (
          arena.nodes[index].kind == StatementKind.throwStatement
          || arena.nodes[index].kind == StatementKind.selectStatement
          || arena.nodes[index].kind == StatementKind.yieldStatement
        ) {
          match (in source.tree) {
            some(tree) => {
              const root = tree.root;
              loweredValue = wrapImplicitOwnedTransfer(
                tree,
                root,
                loweredValue,
                inout expressions
              );
            }
            none => {}
          }
        }
      }
      match (in source.tree) {
        some(tree) => try completeNativeClosureBlocks(
          program,
          importedTypes,
          evidence,
          arena,
          ownerName,
          index,
          expressionStart,
          inout expressions,
          inout statements
        );
        none => {}
      }
      if (
        arena.nodes[index].kind == StatementKind.returnStatement
        || arena.nodes[index].kind == StatementKind.throwStatement
      ) {
        const result = try throwingFunctionResult(
          program,
          importedTypes,
          ownerName
        );
        match (in result) {
          some(declaration) => {
            if (directTryReturn) {
              expression = Option.some(loweredValue);
            } else {
              let children = Array<usize>();
              children.push(loweredValue);
              let labels = Array<String>();
              if (arena.nodes[index].kind == StatementKind.throwStatement) {
                labels.push("failure");
              } else {
                labels.push("success");
              }
              const wrapped = pushExpression(
                inout expressions,
                LoweredExpressionKind.enumPayloadValue,
                declaration.name,
                children,
                labels
              );
              expression = Option.some(wrapped);
            }
          }
          none => expression = Option.some(loweredValue);
        }
      } else {
        expression = Option.some(loweredValue);
      }
    }
    none => {}
  }
  const expressionMissing = match (in expression) {
    some(_) => false;
    none => true;
  };
  if (
    arena.nodes[index].kind == StatementKind.returnStatement
    && expressionMissing
  ) {
    const result = try throwingFunctionResult(
      program,
      importedTypes,
      ownerName
    );
    match (in result) {
      some(declaration) => {
        let labels = Array<String>();
        labels.push("success");
        labels.push("tagged");
        const wrapped = pushExpression(
          inout expressions,
          LoweredExpressionKind.enumValue,
          declaration.name,
          Array<usize>(),
          labels
        );
        expression = Option.some(wrapped);
      }
      none => {}
    }
  }
  let secondExpression = Option<usize>.none;
  match (in arena.nodes[index].secondExpression) {
    some(source) => {
      match (in source.tree) {
        some(tree) => {
          const sourceRoot = tree.root;
          let expectedTypeName = "";
          if (arena.nodes[index].kind == StatementKind.assignmentStatement) {
            match (in arena.nodes[index].expression) {
              some(targetSyntax) => match (in targetSyntax.tree) {
                some(targetTree) => {
                  const targetRoot = targetTree.root;
                  match (matchSubjectTypeName(
                    program,
                    importedTypes,
                    evidence,
                    arena,
                    ownerName,
                    targetTree,
                    targetRoot
                  )) {
                    some(name) => expectedTypeName = move name;
                    none => {}
                  }
                }
                none => {}
              }
              none => {}
            }
          }
          let loweredExpression: usize = 0;
          if (expectedTypeName.byteLength > 0) {
            loweredExpression = try lowerExpressionExpected(
              program,
              importedTypes,
              evidence,
              tree,
              sourceRoot,
              expectedTypeName,
              inout expressions
            );
          } else {
            loweredExpression = try lowerExpression(
              program,
              importedTypes,
              evidence,
              tree,
              sourceRoot,
              inout expressions
            );
          }
          if (arena.nodes[index].kind == StatementKind.assignmentStatement) {
            loweredExpression = wrapImplicitOwnedTransfer(
              tree,
              sourceRoot,
              loweredExpression,
              inout expressions
            );
          }
          secondExpression = Option.some(loweredExpression);
        }
        none => throw "native lowering cannot lower an opaque expression";
      }
    }
    none => {}
  }
  let children = Array<usize>();
  for (const child of arena.nodes[index].children) {
    const loweredChild = try lowerStatement(
      program,
      importedTypes,
      evidence,
      arena,
      ownerName,
      child,
      inout expressions,
      inout statements
    );
    children.push(loweredChild);
  }
  let labels = Array<String>();
  if (arena.nodes[index].kind == StatementKind.throwStatement) {
    labels.push("throw");
  }
  if (arena.nodes[index].kind == StatementKind.forStatement) {
    match (in arena.nodes[index].expression) {
      some(iterable) => match (in iterable.tree) {
        some(tree) => {
          const root = tree.root;
          let typeName = "";
          match (staticallyResolvedExpressionTypeName(
            program,
            importedTypes,
            evidence,
            arena,
            ownerName,
            tree,
            root
          )) {
            some(resolved) => typeName = move resolved;
            none => {}
          }
          if (
            typeName.byteLength == 0
            && tree.nodes[root].kind == ExpressionKind.memberExpression
          ) {
            match (uniquelyResolvedFieldTypeName(
              program,
              importedTypes,
              tree.nodes[root].value
            )) {
              some(resolved) => typeName = move resolved;
              none => {}
            }
          }
          if (typeName.byteLength == 0) {
            match (in type) {
              some(elementType) => {
                typeName = intrinsicArrayName(elementType);
              }
              none => {}
            }
          }
          if (typeName.byteLength == 0) {
            throw `native lowering could not resolve the for iterable type at ${tree.nodes[root].line}:${tree.nodes[root].column}`;
          }
          let viewIterable = false;
          if (
            stringStartsWith(typeName, "view ")
            && typeName.byteLength > 5
          ) {
            typeName = typeName.copyBytes(5, typeName.byteLength);
            viewIterable = true;
          }
          const iterableType = try lowerModuleTypeName(
            program,
            importedTypes,
            typeName
          );
          if (iterableType.kind != LoweredTypeKind.arrayType) {
            throw `native lowering only supports Array for iteration, found ${typeName}`;
          }
          const missingElementType = match (in type) {
            some(_) => false;
            none => true;
          };
          if (missingElementType) {
            match (genericTypeShape(typeName)) {
              some(generic) => {
                if (
                  generic.base == "Array"
                  && generic.arguments.length == 1
                ) {
                  const elementType = try lowerModuleTypeName(
                    program,
                    importedTypes,
                    generic.arguments[0]
                  );
                  type = Option.some(move elementType);
                }
              }
              none => {}
            }
            if (
              stringStartsWith(typeName, "__z_Array_")
              && typeName.byteLength > 10
            ) {
              const elementName = typeName.copyBytes(
                10,
                typeName.byteLength
              );
              const elementType = try lowerModuleTypeName(
                program,
                importedTypes,
                elementName
              );
              type = Option.some(move elementType);
            }
          }
          labels.push(iterableType.name.copyBytes(
            0,
            iterableType.name.byteLength
          ));
          if (viewIterable) labels.push("view");
        }
        none => throw "native lowering cannot iterate an opaque expression";
      }
      none => throw "native lowering received a for statement without an iterable";
    }
  }
  if (arena.nodes[index].kind == StatementKind.forStatement) {
    match (in type) {
      some(_) => {}
      none => throw `native lowering could not find the element type for ${arena.nodes[index].name}`;
    }
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
    cleanups: Array<LoweredCleanup>(),
    liveFlag: "",
    labels,
    matchConsumesSubject: false,
    matchBindingNeedsCleanup: false,
  }));
  return outputIndex;
}

function lowerFunction(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in declaration: FunctionDeclaration,
  in sourcePath: String
): LoweredFunction throws String {
  let delayCount: usize = 0;
  let lastDelayPosition: usize = 0;
  if (declaration.asynchronous && declaration.name != "main") {
    if (declaration.executorAffinity != "thread.main") {
      throw `native lowering does not support suspending async function ${declaration.name} yet`;
    }
    let position: usize = 0;
    while (position < declaration.body.roots.length) {
      const root = declaration.body.roots[position];
      const delay = try mainDelayMillisecondsAtRoot(
        program,
        declaration,
        root
      );
      if (delay.byteLength > 0) {
        delayCount = delayCount + 1;
        lastDelayPosition = position;
      }
      position = position + 1;
    }
  }
  let parameters = Array<LoweredParameter>();
  let ownedParameters = Array<LoweredCleanup>();
  let liveFlags = Array<LoweredLiveFlag>();
  for (const parameter of declaration.parameters) {
    const parameterType = try lowerModuleType(
      program,
      importedTypes,
      parameter.type
    );
    parameters.push(LoweredParameter({
      name: parameter.name.copyBytes(0, parameter.name.byteLength),
      type: move parameterType,
      mode: lowerParameterMode(parameter.mode),
    }));
  }
  let expressions = Array<LoweredExpression>();
  let statements = Array<LoweredStatement>();
  let sourceRoots = Array<usize>();
  let planningRoots = Array<usize>();
  let segmentRoots = Array<usize>();
  let mainDelaySegments = Array<LoweredMainDelaySegment>();
  let rootPosition: usize = 0;
  for (const root of declaration.body.roots) {
    let delay = "";
    if (delayCount > 0) {
      delay = try mainDelayMillisecondsAtRoot(
        program,
        declaration,
        root
      );
    }
    if (delay.byteLength > 0) {
      mainDelaySegments.push(LoweredMainDelaySegment({
        roots: move segmentRoots,
        milliseconds: move delay,
      }));
      segmentRoots = Array<usize>();
      rootPosition = rootPosition + 1;
      continue;
    }
    if (
      delayCount > 0
      && rootPosition < lastDelayPosition
      && (
        declaration.body.nodes[root].kind
          != StatementKind.expressionStatement
        || statementExpressionContainsTry(declaration.body, root)
      )
    ) {
      throw `native lowering does not yet preserve local control flow or bindings across suspension in ${declaration.name}; keep pre-suspension segments to synchronous expression statements`;
    }
    if (delayCount > 0 && rootPosition < lastDelayPosition) {
      let parameterIndex: usize = 0;
      while (parameterIndex < declaration.parameters.length) {
        const parameter = view declaration.parameters[parameterIndex];
        if (statementExpressionWritesName(
          program,
          evidence,
          declaration.body,
          root,
          parameter.name
        )) {
          throw `native lowering does not yet preserve writes to parameter ${parameter.name} across suspension in ${declaration.name}`;
        }
        if (
          moduleTypeNeedsCleanup(
            program,
            importedTypes,
            parameters[parameterIndex].type
          )
          && statementMovesName(
            program,
            evidence,
            declaration.body,
            declaration.body.nodes[root],
            parameter.name
          )
        ) {
          throw `native lowering does not yet preserve ownership transfer of parameter ${parameter.name} across suspension in ${declaration.name}`;
        }
        parameterIndex = parameterIndex + 1;
      }
    }
    sourceRoots.push(root);
    const loweredRoot = try lowerStatement(
      program,
      importedTypes,
      evidence,
      declaration.body,
      declaration.name,
      root,
      inout expressions,
      inout statements
    );
    if (
      delayCount > 0
      && rootPosition < lastDelayPosition
      && statements[loweredRoot].kind
        != LoweredStatementKind.expressionStatement
    ) {
      throw `native lowering does not yet preserve normalized control flow across suspension in ${declaration.name}`;
    }
    planningRoots.push(loweredRoot);
    segmentRoots.push(loweredRoot);
    rootPosition = rootPosition + 1;
  }
  const roots = move segmentRoots;
  let parameterIndex: usize = 0;
  while (parameterIndex < declaration.parameters.length) {
    const parameter = view declaration.parameters[parameterIndex];
    const parameterType = view parameters[parameterIndex].type;
    if (
      parameter.mode == ParameterMode.value
      && moduleTypeNeedsCleanup(program, importedTypes, parameterType)
    ) {
      const parameterName = parameter.name.copyBytes(
        0,
        parameter.name.byteLength
      );
      const parameterOffset = parameter.offset;
      const moved = arenaMovesName(
        program,
        evidence,
        declaration.body,
        parameterName
      ) || loweredThreadSpawnMovesBinding(
        expressions,
        parameterName,
        parameterOffset
      );
      let guard = "";
      if (moved && arenaHasControlFlow(declaration.body)) {
        guard = ownerLiveFlag(parameter.name);
        liveFlags.push(LoweredLiveFlag({
          owner: parameter.name.copyBytes(0, parameter.name.byteLength),
          name: guard.copyBytes(0, guard.byteLength),
          parameter: true,
        }));
      }
      if (!moved || guard.byteLength > 0) {
        ownedParameters.push(LoweredCleanup({
          name: parameter.name.copyBytes(0, parameter.name.byteLength),
          type: LoweredType({
            kind: parameterType.kind,
            name: parameterType.name.copyBytes(0, parameterType.name.byteLength),
          }),
          guard: move guard,
        }));
      }
    }
    parameterIndex = parameterIndex + 1;
  }
  const rootLoopCleanups = Array<LoweredCleanup>();
  const introduced = try planCleanupSequence(
    program,
    importedTypes,
    evidence,
    declaration.body,
    declaration.name,
    sourceRoots,
    planningRoots,
    ownedParameters,
    expressions,
    inout statements,
    inout liveFlags,
    false,
    rootLoopCleanups
  );
  let fallthroughCleanups = Array<LoweredCleanup>();
  appendCleanupCopies(inout fallthroughCleanups, ownedParameters);
  appendCleanupCopies(inout fallthroughCleanups, introduced);
  attachMoveLiveFlags(inout expressions, liveFlags);
  rewriteParameterValues(parameters, inout expressions);
  let returnType = try lowerModuleType(
    program,
    importedTypes,
    declaration.returnType
  );
  let fallthroughExpression = Option<usize>.none;
  const resultType = try throwingFunctionResult(
    program,
    importedTypes,
    declaration.name
  );
  match (in resultType) {
    some(result) => {
      returnType = LoweredType({
        kind: LoweredTypeKind.enumType,
        name: result.name.copyBytes(0, result.name.byteLength),
      });
      if (declaration.returnType.name == "void") {
        let labels = Array<String>();
        labels.push("success");
        labels.push("tagged");
        const successTypeName = result.name.copyBytes(
          0,
          result.name.byteLength
        );
        const success = pushExpression(
          inout expressions,
          LoweredExpressionKind.enumValue,
          successTypeName,
          Array<usize>(),
          labels
        );
        fallthroughExpression = Option.some(success);
      }
    }
    none => {}
  }
  return LoweredFunction({
    name: declaration.name.copyBytes(0, declaration.name.byteLength),
    testName: declaration.testName.copyBytes(0, declaration.testName.byteLength),
    sourcePath: sourcePath.copyBytes(0, sourcePath.byteLength),
    nativeCExportName: declaration.nativeCExport
      ? declaration.name.copyBytes(0, declaration.name.byteLength)
      : "",
    asynchronous: declaration.asynchronous,
    mainDelaySegments,
    receiverType: Option<LoweredType>.none,
    receiverMode: LoweredParameterMode.value,
    parameters,
    returnType: move returnType,
    fallthroughExpression,
    expressions,
    statements,
    roots,
    fallthroughCleanups,
    liveFlags,
  });
}

function lowerDeinitializer(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in ownerName: String,
  in body: StatementArena
): LoweredFunction throws String {
  let expressions = Array<LoweredExpression>();
  let statements = Array<LoweredStatement>();
  let liveFlags = Array<LoweredLiveFlag>();
  let sourceRoots = Array<usize>();
  let roots = Array<usize>();
  for (const root of body.roots) {
    sourceRoots.push(root);
    const loweredRoot = try lowerStatement(
      program,
      importedTypes,
      evidence,
      body,
      `${ownerName}.deinit`,
      root,
      inout expressions,
      inout statements
    );
    roots.push(loweredRoot);
  }
  const inherited = Array<LoweredCleanup>();
  const loopCleanups = Array<LoweredCleanup>();
  const introduced = try planCleanupSequence(
    program,
    importedTypes,
    evidence,
    body,
    `${ownerName}.deinit`,
    sourceRoots,
    roots,
    inherited,
    expressions,
    inout statements,
    inout liveFlags,
    false,
    loopCleanups
  );
  let fallthroughCleanups = Array<LoweredCleanup>();
  appendCleanupCopies(inout fallthroughCleanups, introduced);
  attachMoveLiveFlags(inout expressions, liveFlags);
  return LoweredFunction({
    name: `${ownerName}.deinit`,
    testName: "",
    sourcePath: "",
    nativeCExportName: "",
    asynchronous: false,
    mainDelaySegments: Array<LoweredMainDelaySegment>(),
    receiverType: Option<LoweredType>.none,
    receiverMode: LoweredParameterMode.value,
    parameters: Array<LoweredParameter>(),
    returnType: LoweredType({ kind: LoweredTypeKind.voidType, name: "" }),
    fallthroughExpression: Option<usize>.none,
    expressions,
    statements,
    roots,
    fallthroughCleanups,
    liveFlags,
  });
}

function containsLoweredEnum(
  in enums: Array<LoweredEnum>,
  in name: String
): boolean {
  for (const declaration of enums) {
    if (declaration.name == name) return true;
  }
  return false;
}

function containsLoweredStruct(
  in structs: Array<LoweredStruct>,
  in name: String
): boolean {
  for (const declaration of structs) {
    if (declaration.name == name) return true;
  }
  return false;
}

function containsLoweredArray(
  in arrays: Array<LoweredArray>,
  in name: String
): boolean {
  for (const declaration of arrays) {
    if (declaration.name == name) return true;
  }
  return false;
}

function containsLoweredMap(
  in maps: Array<LoweredMap>,
  in name: String
): boolean {
  for (const declaration of maps) {
    if (declaration.name == name) return true;
  }
  return false;
}

function containsLoweredSet(
  in sets: Array<LoweredSet>,
  in name: String
): boolean {
  for (const declaration of sets) {
    if (declaration.name == name) return true;
  }
  return false;
}

function containsLoweredFunction(
  in functions: Array<LoweredFunction>,
  in name: String
): boolean {
  for (const declaration of functions) {
    if (declaration.name == name) return true;
  }
  return false;
}

function functionIsExported(
  in program: Program,
  in name: String
): boolean {
  for (const declaration of program.declarations) {
    if (
      declaration.kind == DeclarationKind.functionDeclaration
      && declaration.name == name
    ) return declaration.exported;
  }
  return false;
}

function containsName(in names: Array<String>, in name: String): boolean {
  for (const candidate of names) {
    if (candidate == name) return true;
  }
  return false;
}

function collisionSafePrivateFunctionNames(
  in parsed: Array<ParsedModule>,
  includeTests: boolean
): Array<String> {
  let names = Array<String>();
  for (const module of parsed) {
    for (const declaration of module.program.functions) {
      if (declaration.testDeclaration && !includeTests) continue;
      if (containsName(names, declaration.name)) continue;
      let count: usize = 0;
      let exportedCount: usize = 0;
      for (const candidateModule of parsed) {
        for (const candidate of candidateModule.program.functions) {
          if (candidate.testDeclaration && !includeTests) continue;
          if (candidate.name != declaration.name) continue;
          count = count + 1;
          if (functionIsExported(
            candidateModule.program,
            candidate.name
          )) exportedCount = exportedCount + 1;
        }
      }
      if (count > 1 && exportedCount <= 1) {
        names.push(declaration.name.copyBytes(
          0,
          declaration.name.byteLength
        ));
      }
    }
  }
  return names;
}

function privateFunctionNeedsMangle(
  in program: Program,
  in collisionNames: Array<String>,
  moduleIndex: usize,
  entryIndex: usize,
  in name: String
): boolean {
  if (!containsName(collisionNames, name)) return false;
  if (functionIsExported(program, name)) return false;
  return moduleIndex != entryIndex || name != "main";
}

function emittedPrivateFunctionName(
  moduleIndex: usize,
  in name: String
): String {
  return `__z_module_${moduleIndex}_${name}`;
}

function emittedNativeCExportImplementationName(
  moduleIndex: usize,
  in name: String
): String {
  return `__z_c_impl_${moduleIndex}_${name}`;
}

function typeIsExported(
  in program: Program,
  in name: String
): boolean {
  for (const declaration of program.declarations) {
    if (
      (
        declaration.kind == DeclarationKind.structDeclaration
        || declaration.kind == DeclarationKind.classDeclaration
        || declaration.kind == DeclarationKind.enumDeclaration
      )
      && declaration.name == name
    ) return declaration.exported;
  }
  return false;
}

function programTypeCount(in program: Program, in name: String): usize {
  let count: usize = 0;
  for (const aggregate of program.aggregates) {
    if (aggregate.name == name) count = count + 1;
  }
  for (const declaration of program.enums) {
    if (declaration.name == name) count = count + 1;
  }
  return count;
}

function collisionSafePrivateTypeNames(
  in parsed: Array<ParsedModule>
): Array<String> {
  let names = Array<String>();
  for (const module of parsed) {
    for (const declaration of module.program.declarations) {
      if (
        declaration.kind != DeclarationKind.structDeclaration
        && declaration.kind != DeclarationKind.classDeclaration
        && declaration.kind != DeclarationKind.enumDeclaration
      ) continue;
      if (containsName(names, declaration.name)) continue;
      let count: usize = 0;
      let exportedCount: usize = 0;
      for (const candidateModule of parsed) {
        count = count + programTypeCount(
          candidateModule.program,
          declaration.name
        );
        if (typeIsExported(
          candidateModule.program,
          declaration.name
        )) exportedCount = exportedCount + 1;
      }
      if (count > 1 && exportedCount <= 1) {
        names.push(declaration.name.copyBytes(
          0,
          declaration.name.byteLength
        ));
      }
    }
  }
  return names;
}

function privateTypeNeedsMangle(
  in program: Program,
  in collisionNames: Array<String>,
  in name: String
): boolean {
  return containsName(collisionNames, name)
    && !typeIsExported(program, name);
}

function emittedPrivateTypeName(
  moduleIndex: usize,
  in name: String
): String {
  return `module_${moduleIndex}_${name}`;
}

function rewritePrivateCallTargets(
  in program: Program,
  in collisionNames: Array<String>,
  moduleIndex: usize,
  entryIndex: usize,
  inout lowered: LoweredFunction
): void {
  let index: usize = 0;
  while (index < lowered.expressions.length) {
    if (
      lowered.expressions[index].kind == LoweredExpressionKind.directCall
      && lowered.expressions[index].children.length > 0
    ) {
      const callee = lowered.expressions[index].children[0];
      if (
        lowered.expressions[callee].kind == LoweredExpressionKind.localValue
      ) {
        for (const declaration of program.functions) {
          if (
            declaration.name == lowered.expressions[callee].value
            && privateFunctionNeedsMangle(
              program,
              collisionNames,
              moduleIndex,
              entryIndex,
              declaration.name
            )
          ) {
            lowered.expressions[callee] = LoweredExpression({
              kind: LoweredExpressionKind.localValue,
              value: emittedPrivateFunctionName(
                moduleIndex,
                declaration.name
              ),
              children: Array<usize>(),
              statements: Array<usize>(),
              labels: Array<String>(),
            });
          }
        }
      }
    }
    index = index + 1;
  }
}

function rewriteNativeCExportCallTargets(
  inout functions: Array<LoweredFunction>
): void {
  let exportIndex: usize = 0;
  while (exportIndex < functions.length) {
    const publicName = functions[exportIndex].nativeCExportName.copyBytes(
      0,
      functions[exportIndex].nativeCExportName.byteLength
    );
    const implementationName = functions[exportIndex].name.copyBytes(
      0,
      functions[exportIndex].name.byteLength
    );
    if (publicName.byteLength == 0) {
      exportIndex = exportIndex + 1;
      continue;
    }
    let functionIndex: usize = 0;
    while (functionIndex < functions.length) {
      let index: usize = 0;
      while (index < functions[functionIndex].expressions.length) {
        if (
          functions[functionIndex].expressions[index].kind
            == LoweredExpressionKind.directCall
          && functions[functionIndex].expressions[index].children.length > 0
        ) {
          const callee = functions[functionIndex].expressions[
            index
          ].children[0];
          if (
            functions[functionIndex].expressions[callee].kind
              == LoweredExpressionKind.localValue
            && functions[functionIndex].expressions[callee].value
              == publicName
          ) {
            functions[functionIndex].expressions[callee] = LoweredExpression({
              kind: LoweredExpressionKind.localValue,
              value: implementationName.copyBytes(
                0,
                implementationName.byteLength
              ),
              children: Array<usize>(),
              statements: Array<usize>(),
              labels: Array<String>(),
            });
          }
        }
        index = index + 1;
      }
      functionIndex = functionIndex + 1;
    }
    exportIndex = exportIndex + 1;
  }
}

function collectIntrinsicTypeName(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in name: String,
  inout arrays: Array<LoweredArray>,
  inout maps: Array<LoweredMap>,
  inout sets: Array<LoweredSet>,
  inout enums: Array<LoweredEnum>
): void throws String {
  match (genericTypeShape(name)) {
    some(generic) => {
      for (const argument of generic.arguments) {
        try collectIntrinsicTypeName(
          program,
          importedTypes,
          argument,
          inout arrays,
          inout maps,
          inout sets,
          inout enums
        );
      }
      if (generic.base == "Task" && generic.arguments.length == 2) {
        const resultName = `Result<${generic.arguments[0]}, ${generic.arguments[1]}>`;
        try collectIntrinsicTypeName(
          program,
          importedTypes,
          resultName,
          inout arrays,
          inout maps,
          inout sets,
          inout enums
        );
      }
      const array = try intrinsicArrayDeclaration(
        program,
        importedTypes,
        name
      );
      match (array) {
        some(declaration) => {
          if (!containsLoweredArray(arrays, declaration.name)) {
            arrays.push(move declaration);
          }
        }
        none => {}
      }
      const map = try intrinsicMapDeclaration(
        program,
        importedTypes,
        name
      );
      match (map) {
        some(declaration) => {
          if (!containsLoweredMap(maps, declaration.name)) {
            maps.push(move declaration);
          }
        }
        none => {}
      }
      const set = try intrinsicSetDeclaration(
        program,
        importedTypes,
        name
      );
      match (set) {
        some(declaration) => {
          if (!containsLoweredSet(sets, declaration.name)) {
            sets.push(move declaration);
          }
        }
        none => {}
      }
      const intrinsic = try intrinsicEnumDeclaration(
        program,
        importedTypes,
        name
      );
      match (intrinsic) {
        some(declaration) => {
          if (!containsLoweredEnum(enums, declaration.name)) {
            enums.push(move declaration);
          }
        }
        none => {}
      }
    }
    none => {}
  }
}

function collectArenaIntrinsicEnums(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in arena: StatementArena,
  inout arrays: Array<LoweredArray>,
  inout maps: Array<LoweredMap>,
  inout sets: Array<LoweredSet>,
  inout enums: Array<LoweredEnum>
): void throws String {
  for (const statement of arena.nodes) {
    match (in statement.typeAnnotation) {
      some(type) => try collectIntrinsicTypeName(
        program,
        importedTypes,
        type.name,
        inout arrays,
        inout maps,
        inout sets,
        inout enums
      );
      none => {}
    }
    match (in statement.expression) {
      some(expression) => {
        match (in expression.tree) {
          some(tree) => {
            for (const node of tree.nodes) {
              try collectIntrinsicTypeName(
                program,
                importedTypes,
                node.value,
                inout arrays,
                inout maps,
                inout sets,
                inout enums
              );
              if (
                node.kind == ExpressionKind.closureExpression
                && node.labels.length > 1
                && node.labels[0].byteLength > 0
                && node.labels[1].byteLength > 0
              ) {
                const workerResult = `Result<${node.labels[0]}, ${node.labels[1]}>`;
                try collectIntrinsicTypeName(
                  program,
                  importedTypes,
                  workerResult,
                  inout arrays,
                  inout maps,
                  inout sets,
                  inout enums
                );
              }
            }
          }
          none => {}
        }
      }
      none => {}
    }
    match (in statement.secondExpression) {
      some(expression) => {
        match (in expression.tree) {
          some(tree) => {
            for (const node of tree.nodes) {
              try collectIntrinsicTypeName(
                program,
                importedTypes,
                node.value,
                inout arrays,
                inout maps,
                inout sets,
                inout enums
              );
            }
          }
          none => {}
        }
      }
      none => {}
    }
  }
}

function collectIntrinsicEnums(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  includeTests: boolean,
  inout arrays: Array<LoweredArray>,
  inout maps: Array<LoweredMap>,
  inout sets: Array<LoweredSet>,
  inout enums: Array<LoweredEnum>
): void throws String {
  for (const binding of evidence.bindingResolutions) {
    try collectIntrinsicTypeName(
      program,
      importedTypes,
      binding.typeName,
      inout arrays,
      inout maps,
      inout sets,
      inout enums
    );
  }
  for (const expression of evidence.expressionResolutions) {
    try collectIntrinsicTypeName(
      program,
      importedTypes,
      expression.typeName,
      inout arrays,
      inout maps,
      inout sets,
      inout enums
    );
  }
  for (const call of evidence.callResolutions) {
    if (call.errorType.byteLength == 0) continue;
    const resultName = `Result<${call.returnType}, ${call.errorType}>`;
    try collectIntrinsicTypeName(
      program,
      importedTypes,
      resultName,
      inout arrays,
      inout maps,
      inout sets,
      inout enums
    );
  }
  for (const aggregate of program.aggregates) {
    for (const field of aggregate.fields) {
      try collectIntrinsicTypeName(
        program,
        importedTypes,
        field.type.name,
        inout arrays,
        inout maps,
        inout sets,
        inout enums
      );
    }
    match (in aggregate.deinitializer) {
      some(deinitializer) => try collectArenaIntrinsicEnums(
        program,
        importedTypes,
        deinitializer.body,
        inout arrays,
        inout maps,
        inout sets,
        inout enums
      );
      none => {}
    }
  }
  for (const declaration of program.enums) {
    for (const variant of declaration.variants) {
      match (in variant.payload) {
        some(type) => try collectIntrinsicTypeName(
          program,
          importedTypes,
          type.name,
          inout arrays,
          inout maps,
          inout sets,
          inout enums
        );
        none => {}
      }
    }
  }
  for (const declaration of program.functions) {
    if (declaration.testDeclaration && !includeTests) continue;
    for (const parameter of declaration.parameters) {
      try collectIntrinsicTypeName(
        program,
        importedTypes,
        parameter.type.name,
        inout arrays,
        inout maps,
        inout sets,
        inout enums
      );
    }
    try collectIntrinsicTypeName(
      program,
      importedTypes,
      declaration.returnType.name,
      inout arrays,
      inout maps,
      inout sets,
      inout enums
    );
    match (in declaration.errorType) {
      some(type) => {
        try collectIntrinsicTypeName(
          program,
          importedTypes,
          type.name,
          inout arrays,
          inout maps,
          inout sets,
          inout enums
        );
        const returnName = declaration.returnType.name.copyBytes(
          0,
          declaration.returnType.name.byteLength
        );
        const errorName = type.name.copyBytes(0, type.name.byteLength);
        const resultName = `Result<${returnName}, ${errorName}>`;
        try collectIntrinsicTypeName(
          program,
          importedTypes,
          resultName,
          inout arrays,
          inout maps,
          inout sets,
          inout enums
        );
      }
      none => {}
    }
    try collectArenaIntrinsicEnums(
      program,
      importedTypes,
      declaration.body,
      inout arrays,
      inout maps,
      inout sets,
      inout enums
    );
  }
}

function loweredStructCleanup(
  in structs: Array<LoweredStruct>,
  in name: String
): Option<boolean> {
  for (const declaration of structs) {
    if (declaration.name == name) {
      return Option.some(declaration.needsDeinit);
    }
  }
  return Option<boolean>.none;
}

function loweredStructFields(
  in structs: Array<LoweredStruct>,
  in name: String
): Array<LoweredField> {
  let fields = Array<LoweredField>();
  for (const declaration of structs) {
    if (declaration.name != name) continue;
    for (const field of declaration.fields) {
      fields.push(LoweredField({
        name: field.name.copyBytes(0, field.name.byteLength),
        type: LoweredType({
          kind: field.type.kind,
          name: field.type.name.copyBytes(0, field.type.name.byteLength),
        }),
        optionalField: field.optionalField,
      }));
    }
  }
  return fields;
}

function loweredStructIsReference(
  in structs: Array<LoweredStruct>,
  in name: String
): boolean {
  for (const declaration of structs) {
    if (declaration.name == name) return declaration.referenceType;
  }
  return false;
}

function loweredStructThreadShareable(
  in structs: Array<LoweredStruct>,
  in name: String
): boolean {
  for (const declaration of structs) {
    if (declaration.name == name) return declaration.threadShareable;
  }
  return false;
}

function loweredStructWorkerDestructible(
  in structs: Array<LoweredStruct>,
  in name: String
): boolean {
  for (const declaration of structs) {
    if (declaration.name == name) return declaration.workerDestructible;
  }
  return false;
}

function copyLoweredVariant(in variant: LoweredVariant): LoweredVariant {
  let payload = Option<LoweredType>.none;
  match (in variant.payload) {
    some(type) => payload = Option.some(LoweredType({
      kind: type.kind,
      name: type.name.copyBytes(0, type.name.byteLength),
    }));
    none => {}
  }
  return LoweredVariant({
    name: variant.name.copyBytes(0, variant.name.byteLength),
    payload,
  });
}

function loweredEnumCopy(
  in enums: Array<LoweredEnum>,
  in name: String
): Option<LoweredEnum> {
  for (const declaration of enums) {
    if (declaration.name != name) continue;
    let variants = Array<LoweredVariant>();
    for (const variant of declaration.variants) {
      variants.push(copyLoweredVariant(variant));
    }
    return Option.some(LoweredEnum({
      name: declaration.name.copyBytes(0, declaration.name.byteLength),
      nativeCName: declaration.nativeCName.copyBytes(
        0,
        declaration.nativeCName.byteLength
      ),
      nativeCUnderlyingType: declaration.nativeCUnderlyingType.copyBytes(
        0,
        declaration.nativeCUnderlyingType.byteLength
      ),
      variants,
      payloadBearing: declaration.payloadBearing,
      needsDeinit: declaration.needsDeinit,
    }));
  }
  return Option<LoweredEnum>.none;
}

function importedTypesForModule(
  in graph: ModuleGraph,
  in structs: Array<LoweredStruct>,
  in enums: Array<LoweredEnum>,
  moduleIndex: usize
): Array<LoweredImportedType> {
  let types = Array<LoweredImportedType>();
  for (const symbol of graph.modules[moduleIndex].symbols) {
    if (
      symbol.kind == ModuleSymbolKind.enumSymbol
      && symbol.foreignHeader.byteLength > 0
    ) {
      match (in symbol.typeSignature) {
        some(signature) => {
          if (
            signature.foreignNativeName.byteLength > 0
            && signature.foreignUnderlyingType.byteLength > 0
          ) {
            types.push(LoweredImportedType({
              localName: symbol.name.copyBytes(0, symbol.name.byteLength),
              targetName: signature.foreignNativeName.copyBytes(
                0,
                signature.foreignNativeName.byteLength
              ),
              kind: LoweredTypeKind.foreignEnumType,
              threadShareable: false,
              workerDestructible: false,
              needsDeinit: false,
              fields: Array<LoweredField>(),
              variants: Array<LoweredVariant>(),
              payloadBearing: false,
              underlyingType: signature.foreignUnderlyingType.copyBytes(
                0,
                signature.foreignUnderlyingType.byteLength
              ),
            }));
          }
        }
        none => {}
      }
      continue;
    }
    if (symbol.kind != ModuleSymbolKind.importedSymbol) continue;
    let targetModule = graph.modules.length;
    match (in symbol.targetModule) {
      some(index) => targetModule = index;
      none => {}
    }
    if (targetModule >= graph.modules.length) continue;
    const targetSymbol = moduleSymbolIndex(
      graph.modules[targetModule],
      symbol.importedName
    );
    if (targetSymbol >= graph.modules[targetModule].symbols.length) continue;
    if (
      graph.modules[targetModule].symbols[targetSymbol].kind
        == ModuleSymbolKind.structSymbol
      || graph.modules[targetModule].symbols[targetSymbol].kind
        == ModuleSymbolKind.classSymbol
    ) {
      const targetName = graph.modules[targetModule].symbols[
        targetSymbol
      ].name.copyBytes(
        0,
        graph.modules[targetModule].symbols[targetSymbol].name.byteLength
      );
      match (loweredStructCleanup(structs, targetName)) {
        some(needsDeinit) => {
          const fields = loweredStructFields(structs, targetName);
          const referenceType = loweredStructIsReference(
            structs,
            targetName
          );
          types.push(LoweredImportedType({
            localName: symbol.name.copyBytes(0, symbol.name.byteLength),
            targetName: targetName.copyBytes(0, targetName.byteLength),
            kind: referenceType
              ? LoweredTypeKind.classType
              : LoweredTypeKind.structType,
            threadShareable: loweredStructThreadShareable(
              structs,
              targetName
            ),
            workerDestructible: loweredStructWorkerDestructible(
              structs,
              targetName
            ),
            needsDeinit,
            fields,
            variants: Array<LoweredVariant>(),
            payloadBearing: false,
            underlyingType: "",
          }));
        }
        none => {}
      }
    } else if (
      graph.modules[targetModule].symbols[targetSymbol].kind
        == ModuleSymbolKind.enumSymbol
    ) {
      const targetName = graph.modules[targetModule].symbols[
        targetSymbol
      ].name.copyBytes(
        0,
        graph.modules[targetModule].symbols[targetSymbol].name.byteLength
      );
      match (loweredEnumCopy(enums, targetName)) {
        some(declaration) => {
          let variants = Array<LoweredVariant>();
          for (const variant of declaration.variants) {
            variants.push(copyLoweredVariant(variant));
          }
          types.push(LoweredImportedType({
            localName: symbol.name.copyBytes(0, symbol.name.byteLength),
            targetName,
            kind: LoweredTypeKind.enumType,
            threadShareable: false,
            workerDestructible: !declaration.needsDeinit,
            needsDeinit: declaration.needsDeinit,
            fields: Array<LoweredField>(),
            variants,
            payloadBearing: declaration.payloadBearing,
            underlyingType: "",
          }));
        }
        none => {}
      }
    }
  }
  // Public types can flow through an imported function signature without a
  // second explicit type import in the consuming module. Keep their canonical
  // lowered identity available for inferred locals and intrinsic containers.
  for (const candidateModule of graph.modules) {
    for (const symbol of candidateModule.symbols) {
      if (!symbol.exported) continue;
      let present = false;
      for (const type of types) {
        if (
          type.localName == symbol.name
          || type.targetName == symbol.name
        ) present = true;
      }
      if (present) continue;
      if (
        symbol.kind == ModuleSymbolKind.structSymbol
        || symbol.kind == ModuleSymbolKind.classSymbol
      ) {
        match (loweredStructCleanup(structs, symbol.name)) {
          some(needsDeinit) => {
            const fields = loweredStructFields(structs, symbol.name);
            types.push(LoweredImportedType({
              localName: symbol.name.copyBytes(0, symbol.name.byteLength),
              targetName: symbol.name.copyBytes(0, symbol.name.byteLength),
              kind: loweredStructIsReference(structs, symbol.name)
                ? LoweredTypeKind.classType
                : LoweredTypeKind.structType,
              threadShareable: loweredStructThreadShareable(
                structs,
                symbol.name
              ),
              workerDestructible: loweredStructWorkerDestructible(
                structs,
                symbol.name
              ),
              needsDeinit,
              fields,
              variants: Array<LoweredVariant>(),
              payloadBearing: false,
              underlyingType: "",
            }));
          }
          none => {}
        }
      } else if (symbol.kind == ModuleSymbolKind.enumSymbol) {
        match (loweredEnumCopy(enums, symbol.name)) {
          some(declaration) => {
            let variants = Array<LoweredVariant>();
            for (const variant of declaration.variants) {
              variants.push(copyLoweredVariant(variant));
            }
            types.push(LoweredImportedType({
              localName: symbol.name.copyBytes(0, symbol.name.byteLength),
              targetName: symbol.name.copyBytes(0, symbol.name.byteLength),
              kind: LoweredTypeKind.enumType,
              threadShareable: false,
              workerDestructible: !declaration.needsDeinit,
              needsDeinit: declaration.needsDeinit,
              fields: Array<LoweredField>(),
              variants,
              payloadBearing: declaration.payloadBearing,
              underlyingType: "",
            }));
          }
          none => {}
        }
      }
    }
  }
  return types;
}

function moduleConstantNumericType(in value: String): String {
  let index: usize = 0;
  while (index < value.byteLength) {
    const byte = value.byteAt(index);
    if (byte == 46 || byte == 69 || byte == 101) return "f64";
    index = index + 1;
  }
  return "i32";
}

function lowerModuleConstant(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in declaration: ModuleConstantDeclaration,
  moduleIndex: usize
): LoweredConstant throws String {
  match (in declaration.initializer.tree) {
    some(tree) => {
      const root = view tree.nodes[tree.root];
      if (
        root.kind == ExpressionKind.callExpression
        && root.children.length == 1
        && tree.nodes[root.children[0]].kind
          == ExpressionKind.identifierExpression
      ) {
        const callee = view tree.nodes[root.children[0]].value;
        match (genericTypeShape(callee)) {
          some(generic) => {
            if (
              generic.base == "Once"
              && generic.arguments.length == 1
            ) {
              const type = try lowerModuleTypeName(
                program,
                importedTypes,
                callee
              );
              return LoweredConstant({
                name: `__z_module_${moduleIndex}_${declaration.name}`,
                type,
                initializerKind: LoweredExpressionKind.onceEmpty,
                value: "",
              });
            }
          }
          none => {}
        }
      }
      let initializerKind = LoweredExpressionKind.integerValue;
      let value = root.value.copyBytes(0, root.value.byteLength);
      let inferredType = "i32";
      if (root.kind == ExpressionKind.stringExpression) {
        initializerKind = LoweredExpressionKind.stringValue;
        inferredType = "String";
      } else if (root.kind == ExpressionKind.booleanExpression) {
        initializerKind = LoweredExpressionKind.booleanValue;
        inferredType = "boolean";
      } else if (root.kind == ExpressionKind.numberExpression) {
        initializerKind = LoweredExpressionKind.integerValue;
        inferredType = moduleConstantNumericType(root.value);
      } else if (
        root.kind == ExpressionKind.unaryExpression
        && root.children.length == 1
        && (
          root.value == "+"
          || root.value == "-"
        )
        && tree.nodes[root.children[0]].kind == ExpressionKind.numberExpression
      ) {
        initializerKind = LoweredExpressionKind.integerValue;
        const operand = view tree.nodes[root.children[0]].value;
        value = `${root.value}${operand}`;
        inferredType = moduleConstantNumericType(operand);
      } else {
        throw `module constant ${declaration.name} requires a cleanup-free literal initializer in the first native tier`;
      }
      const type = match (in declaration.typeAnnotation) {
        some(annotation) => try lowerModuleType(
          program,
          importedTypes,
          annotation
        );
        none => try lowerModuleTypeName(
          program,
          importedTypes,
          inferredType
        );
      };
      return LoweredConstant({
        name: `__z_module_${moduleIndex}_${declaration.name}`,
        type,
        initializerKind,
        value,
      });
    }
    none => throw `module constant ${declaration.name} has no initializer`;
  }
}

function appendLoweredProgram(
  in program: Program,
  in sourcePath: String,
  inout importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in privateFunctionCollisionNames: Array<String>,
  in privateTypeCollisionNames: Array<String>,
  moduleIndex: usize,
  entryIndex: usize,
  includeTests: boolean,
  inout constants: Array<LoweredConstant>,
  inout arrays: Array<LoweredArray>,
  inout maps: Array<LoweredMap>,
  inout sets: Array<LoweredSet>,
  inout structs: Array<LoweredStruct>,
  inout enums: Array<LoweredEnum>,
  inout functions: Array<LoweredFunction>
): void throws String {
  if (
    program.traits.length > 0
    || program.typeAliases.length > 0
  ) {
    throw "native lowering does not support traits or type aliases yet";
  }

  for (const declaration of program.constants) {
    const loweredConstant = try lowerModuleConstant(
      program,
      importedTypes,
      declaration,
      moduleIndex
    );
    constants.push(move loweredConstant);
  }

  for (const declaration of program.enums) {
    if (!privateTypeNeedsMangle(
      program,
      privateTypeCollisionNames,
      declaration.name
    )) continue;
    const targetName = emittedPrivateTypeName(
      moduleIndex,
      declaration.name
    );
    importedTypes.push(LoweredImportedType({
      localName: declaration.name.copyBytes(
        0,
        declaration.name.byteLength
      ),
      targetName,
      kind: LoweredTypeKind.enumType,
      threadShareable: false,
      workerDestructible: false,
      needsDeinit: false,
      fields: Array<LoweredField>(),
      variants: Array<LoweredVariant>(),
      payloadBearing: false,
      underlyingType: "",
    }));
  }
  for (const aggregate of program.aggregates) {
    if (
      (
        aggregate.kind != DeclarationKind.structDeclaration
        && aggregate.kind != DeclarationKind.classDeclaration
      )
      || !privateTypeNeedsMangle(
        program,
        privateTypeCollisionNames,
        aggregate.name
      )
    ) continue;
    const targetName = emittedPrivateTypeName(moduleIndex, aggregate.name);
    importedTypes.push(LoweredImportedType({
      localName: aggregate.name.copyBytes(0, aggregate.name.byteLength),
      targetName,
      kind: aggregate.kind == DeclarationKind.classDeclaration
        ? LoweredTypeKind.classType
        : LoweredTypeKind.structType,
      threadShareable: false,
      workerDestructible: false,
      needsDeinit: false,
      fields: Array<LoweredField>(),
      variants: Array<LoweredVariant>(),
      payloadBearing: false,
      underlyingType: "",
    }));
  }

  try collectIntrinsicEnums(
    program,
    importedTypes,
    evidence,
    includeTests,
    inout arrays,
    inout maps,
    inout sets,
    inout enums
  );
  for (const declaration of program.enums) {
    const emittedName = privateTypeNeedsMangle(
      program,
      privateTypeCollisionNames,
      declaration.name
    )
      ? emittedPrivateTypeName(moduleIndex, declaration.name)
      : declaration.name.copyBytes(0, declaration.name.byteLength);
    if (
      containsLoweredEnum(enums, emittedName)
      || containsLoweredStruct(structs, emittedName)
    ) {
      throw `native module emission requires collision-safe type identity for ${declaration.name}`;
    }
    let variants = Array<LoweredVariant>();
    let payloadBearing = false;
    for (const variant of declaration.variants) {
      let payload = Option<LoweredType>.none;
      match (in variant.payload) {
        some(type) => {
          const lowered = try lowerModuleType(program, importedTypes, type);
          payload = Option.some(move lowered);
          payloadBearing = true;
        }
        none => {}
      }
      variants.push(LoweredVariant({
        name: variant.name.copyBytes(0, variant.name.byteLength),
        payload,
      }));
    }
    const declarationIndex = match (enumIndex(program, declaration.name)) {
      some(index) => index;
      none => throw `native lowering lost enum ${declaration.name}`;
    };
    const needsDeinit = moduleEnumNeedsCleanup(
      program,
      importedTypes,
      declarationIndex,
      0
    );
    let nativeCUnderlyingType = "";
    if (declaration.nativeCLayout) {
      match (in declaration.underlyingType) {
        some(type) => {
          nativeCUnderlyingType = type.name.copyBytes(0, type.name.byteLength);
        }
        none => {}
      }
    }
    let importedVariants = Array<LoweredVariant>();
    for (const variant of variants) {
      importedVariants.push(copyLoweredVariant(variant));
    }
    enums.push(LoweredEnum({
      name: emittedName.copyBytes(0, emittedName.byteLength),
      nativeCName: declaration.nativeCLayout
        ? declaration.name.copyBytes(0, declaration.name.byteLength)
        : "",
      nativeCUnderlyingType,
      variants,
      payloadBearing,
      needsDeinit,
    }));
    importedTypes.push(LoweredImportedType({
      localName: declaration.name.copyBytes(
        0,
        declaration.name.byteLength
      ),
      targetName: emittedName,
      kind: LoweredTypeKind.enumType,
      threadShareable: false,
      workerDestructible: !needsDeinit,
      needsDeinit,
      fields: Array<LoweredField>(),
      variants: importedVariants,
      payloadBearing,
      underlyingType: "",
    }));
  }

  for (const aggregate of program.aggregates) {
    const emittedName = privateTypeNeedsMangle(
      program,
      privateTypeCollisionNames,
      aggregate.name
    )
      ? emittedPrivateTypeName(moduleIndex, aggregate.name)
      : aggregate.name.copyBytes(0, aggregate.name.byteLength);
    if (
      containsLoweredStruct(structs, emittedName)
      || containsLoweredEnum(enums, emittedName)
    ) {
      throw `native module emission requires collision-safe type identity for ${aggregate.name}`;
    }
    if (
      (
        aggregate.kind != DeclarationKind.structDeclaration
        && aggregate.kind != DeclarationKind.classDeclaration
      )
      || aggregate.typeParameters.length > 0
    ) {
      throw "native lowering only supports non-generic structs and classes yet";
    }
    match (in aggregate.constructorDeclaration) {
      some(_) => throw `native lowering does not support constructor on ${aggregate.name} yet`;
      none => {}
    }
    let fields = Array<LoweredField>();
    for (const field of aggregate.fields) {
      const fieldType = try lowerModuleType(
        program,
        importedTypes,
        field.type
      );
      fields.push(LoweredField({
        name: field.name.copyBytes(0, field.name.byteLength),
        type: move fieldType,
        optionalField: field.optionalField,
      }));
    }
    let deinitializer = Option<LoweredFunction>.none;
    match (in aggregate.deinitializer) {
      some(source) => {
        let body = try lowerDeinitializer(
          program,
          importedTypes,
          evidence,
          aggregate.name,
          source.body
        );
        body.name = `${emittedName}.deinit`;
        deinitializer = Option.some(move body);
      }
      none => {}
    }
    let aggregateIndex: usize = program.aggregates.length;
    match (structIndex(program, aggregate.name)) {
      some(index) => aggregateIndex = index;
      none => match (classIndex(program, aggregate.name)) {
        some(index) => aggregateIndex = index;
        none => {}
      }
    }
    if (aggregateIndex >= program.aggregates.length) {
      throw `native lowering lost aggregate ${aggregate.name}`;
    }
    const needsDeinit = moduleAggregateNeedsCleanup(
      program,
      importedTypes,
      aggregateIndex,
      0
    );
    const visiting = Array<String>();
    const threadShareable = moduleTypeIsThreadShareable(
      program,
      importedTypes,
      aggregate.name,
      visiting
    );
    const workerDestructible = moduleTypeIsWorkerDestructible(
      program,
      importedTypes,
      aggregate.name,
      visiting
    );
    structs.push(LoweredStruct({
      name: emittedName,
      nativeCName: aggregate.nativeCLayout
        ? aggregate.name.copyBytes(0, aggregate.name.byteLength)
        : "",
      fields,
      referenceType: aggregate.kind == DeclarationKind.classDeclaration,
      threadShareable,
      workerDestructible,
      needsDeinit,
      deinitializer,
    }));
  }

  for (const aggregate of program.aggregates) {
    const emittedName = privateTypeNeedsMangle(
      program,
      privateTypeCollisionNames,
      aggregate.name
    )
      ? emittedPrivateTypeName(moduleIndex, aggregate.name)
      : aggregate.name.copyBytes(0, aggregate.name.byteLength);
    match (loweredStructCleanup(structs, emittedName)) {
      some(needsDeinit) => {
        const fields = loweredStructFields(structs, emittedName);
        importedTypes.push(LoweredImportedType({
          localName: aggregate.name.copyBytes(0, aggregate.name.byteLength),
          targetName: emittedName.copyBytes(0, emittedName.byteLength),
          kind: aggregate.kind == DeclarationKind.classDeclaration
            ? LoweredTypeKind.classType
            : LoweredTypeKind.structType,
          threadShareable: loweredStructThreadShareable(
            structs,
            emittedName
          ),
          workerDestructible: loweredStructWorkerDestructible(
            structs,
            emittedName
          ),
          needsDeinit,
          fields,
          variants: Array<LoweredVariant>(),
          payloadBearing: false,
          underlyingType: "",
        }));
      }
      none => {}
    }
  }

  for (const aggregate of program.aggregates) {
    const emittedName = privateTypeNeedsMangle(
      program,
      privateTypeCollisionNames,
      aggregate.name
    )
      ? emittedPrivateTypeName(moduleIndex, aggregate.name)
      : aggregate.name.copyBytes(0, aggregate.name.byteLength);
    const receiverKind = aggregate.kind == DeclarationKind.classDeclaration
      ? LoweredTypeKind.classType
      : LoweredTypeKind.structType;
    for (const method of aggregate.methods) {
      if (method.staticMethod) {
        throw `native lowering does not support static method ${aggregate.name}.${method.name} yet`;
      }
      if (method.typeParameters.length > 0) {
        throw `native lowering does not support generic method ${aggregate.name}.${method.name} yet`;
      }
      if (method.receiverMode == ReceiverMode.move) {
        throw `native lowering does not support consuming method ${aggregate.name}.${method.name} yet`;
      }
      match (in method.errorType) {
        some(_) => throw `native lowering does not support throwing method ${aggregate.name}.${method.name} yet`;
        none => {}
      }
      const loweredMethodOutcome = attempt lowerFunction(
        program,
        importedTypes,
        evidence,
        method,
        sourcePath
      );
      let loweredMethod = match (loweredMethodOutcome) {
        success(lowered) => lowered;
        failure(message) => throw `method ${aggregate.name}.${method.name}: ${message}`;
      };
      loweredMethod.name = `Z_${emittedName}_${method.name}`;
      loweredMethod.nativeCExportName = "";
      loweredMethod.receiverType = Option.some(LoweredType({
        kind: receiverKind,
        name: emittedName.copyBytes(0, emittedName.byteLength),
      }));
      loweredMethod.receiverMode = lowerReceiverMode(method.receiverMode);
      rewritePrivateCallTargets(
        program,
        privateFunctionCollisionNames,
        moduleIndex,
        entryIndex,
        inout loweredMethod
      );
      functions.push(move loweredMethod);
    }
  }

  for (const declaration of program.functions) {
    if (declaration.testDeclaration && !includeTests) continue;
    if (
      includeTests
      && moduleIndex == entryIndex
      && declaration.name == "main"
    ) continue;
    if (
      containsLoweredFunction(functions, declaration.name)
      && !containsName(privateFunctionCollisionNames, declaration.name)
    ) {
      throw `native module emission requires collision-safe function identity for ${declaration.name}`;
    }
    const loweredFunctionOutcome = attempt lowerFunction(
      program,
      importedTypes,
      evidence,
      declaration,
      sourcePath
    );
    let loweredFunction = match (loweredFunctionOutcome) {
      success(lowered) => lowered;
      failure(message) => {
        const functionName = declaration.name.copyBytes(
          0,
          declaration.name.byteLength
        );
        throw `function ${functionName}: ${message}`;
      }
    };
    rewritePrivateCallTargets(
      program,
      privateFunctionCollisionNames,
      moduleIndex,
      entryIndex,
      inout loweredFunction
    );
    if (declaration.nativeCExport) {
      loweredFunction.name = emittedNativeCExportImplementationName(
        moduleIndex,
        declaration.name
      );
    } else if (privateFunctionNeedsMangle(
      program,
      privateFunctionCollisionNames,
      moduleIndex,
      entryIndex,
      declaration.name
    )) {
      loweredFunction.name = emittedPrivateFunctionName(
        moduleIndex,
        declaration.name
      );
    }
    functions.push(move loweredFunction);
  }
}

export function lowerProgram(
  in program: Program,
  in evidence: ModuleSemanticEvidence
): LoweredProgram throws String {
  if (program.imports.length > 0) {
    throw "native single-module lowering cannot resolve imports";
  }
  let structs = Array<LoweredStruct>();
  let enums = Array<LoweredEnum>();
  let functions = Array<LoweredFunction>();
  let constants = Array<LoweredConstant>();
  let arrays = Array<LoweredArray>();
  let maps = Array<LoweredMap>();
  let sets = Array<LoweredSet>();
  let foreignHeaders = Array<String>();
  let foreignFunctions = Array<LoweredForeignFunction>();
  let importedTypes = Array<LoweredImportedType>();
  const privateCollisionNames = Array<String>();
  const privateTypeCollisionNames = Array<String>();
  try appendLoweredProgram(
    program,
    "",
    inout importedTypes,
    evidence,
    privateCollisionNames,
    privateTypeCollisionNames,
    0,
    0,
    false,
    inout constants,
    inout arrays,
    inout maps,
    inout sets,
    inout structs,
    inout enums,
    inout functions
  );
  rewriteNativeCExportCallTargets(inout functions);
  return LoweredProgram({
    foreignHeaders,
    foreignFunctions,
    constants,
    arrays,
    maps,
    sets,
    structs,
    enums,
    functions,
  });
}

export function lowerModules(
  in parsed: Array<ParsedModule>,
  in graph: ModuleGraph
): LoweredProgram throws String {
  return try lowerModulesIncludingTests(parsed, graph, false);
}

export function lowerTestModules(
  in parsed: Array<ParsedModule>,
  in graph: ModuleGraph
): LoweredProgram throws String {
  return try lowerModulesIncludingTests(parsed, graph, true);
}

function lowerModulesIncludingTests(
  in parsed: Array<ParsedModule>,
  in graph: ModuleGraph,
  includeTests: boolean
): LoweredProgram throws String {
  let structs = Array<LoweredStruct>();
  let enums = Array<LoweredEnum>();
  let functions = Array<LoweredFunction>();
  let constants = Array<LoweredConstant>();
  let arrays = Array<LoweredArray>();
  let maps = Array<LoweredMap>();
  let sets = Array<LoweredSet>();
  let foreignHeaders = Array<String>();
  let foreignFunctions = Array<LoweredForeignFunction>();
  const privateFunctionCollisionNames = collisionSafePrivateFunctionNames(
    parsed,
    includeTests
  );
  const privateTypeCollisionNames = collisionSafePrivateTypeNames(parsed);
  const entryIndex = graph.entry;
  for (const moduleIndex of graph.dependencyOrder) {
    let importedTypes = importedTypesForModule(
      graph,
      structs,
      enums,
      moduleIndex
    );
    try collectForeignLowering(
      parsed[moduleIndex].program,
      importedTypes,
      graph.modules[moduleIndex].semanticEvidence,
      inout foreignHeaders,
      inout foreignFunctions
    );
    const moduleOutcome = attempt appendLoweredProgram(
      parsed[moduleIndex].program,
      parsed[moduleIndex].path,
      inout importedTypes,
      graph.modules[moduleIndex].semanticEvidence,
      privateFunctionCollisionNames,
      privateTypeCollisionNames,
      moduleIndex,
      entryIndex,
      includeTests,
      inout constants,
      inout arrays,
      inout maps,
      inout sets,
      inout structs,
      inout enums,
      inout functions
    );
    match (moduleOutcome) {
      success => {}
      failure(message) => {
        const path = parsed[moduleIndex].path.copyBytes(
          0,
          parsed[moduleIndex].path.byteLength
        );
        throw `${path}: ${message}`;
      }
    }
  }
  rewriteNativeCExportCallTargets(inout functions);
  return LoweredProgram({
    foreignHeaders,
    foreignFunctions,
    constants,
    arrays,
    maps,
    sets,
    structs,
    enums,
    functions,
  });
}
