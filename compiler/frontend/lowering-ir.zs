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
  i32Type,
  u8Type,
  usizeType,
  stringType,
  arrayType,
  mapType,
  setType,
  structType,
  enumType,
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
  moveValue,
  copyValue,
  borrowedTemporary,
  unaryOperation,
  binaryOperation,
  conditionalValue,
  directCall,
  fieldValue,
  structValue,
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
  forStatement,
  tryStatement,
  matchStatement,
  matchArmStatement,
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

export struct LoweredFunction {
  name: String;
  parameters: Array<LoweredParameter>;
  returnType: LoweredType;
  fallthroughExpression: Option<usize>;
  expressions: Array<LoweredExpression>;
  statements: Array<LoweredStatement>;
  roots: Array<usize>;
  fallthroughCleanups: Array<LoweredCleanup>;
  liveFlags: Array<LoweredLiveFlag>;
}

export struct LoweredProgram {
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
  needsDeinit: boolean;
  fields: Array<LoweredField>;
  variants: Array<LoweredVariant>;
  payloadBearing: boolean;
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
  if (type.kind == LoweredTypeKind.i32Type) return "i32";
  if (type.kind == LoweredTypeKind.u8Type) return "u8";
  if (type.kind == LoweredTypeKind.usizeType) return "usize";
  if (type.kind == LoweredTypeKind.stringType) return "String";
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

function lowerTypeName(
  in program: Program,
  in name: String
): LoweredType throws String {
  if (name == "void") return LoweredType({ kind: LoweredTypeKind.voidType, name: "" });
  if (name == "boolean") {
    return LoweredType({ kind: LoweredTypeKind.booleanType, name: "" });
  }
  if (name == "i32") return LoweredType({ kind: LoweredTypeKind.i32Type, name: "" });
  if (name == "u8") return LoweredType({ kind: LoweredTypeKind.u8Type, name: "" });
  if (name == "usize") {
    return LoweredType({ kind: LoweredTypeKind.usizeType, name: "" });
  }
  if (name == "String" || name == "TextBuffer") {
    return LoweredType({
      kind: LoweredTypeKind.stringType,
      name: "String",
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
      && tree.nodes[callee].value == "finish"
      && tree.nodes[callee].children.length == 1
    ) {
      const receiver = tree.nodes[callee].children[0];
      if (
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
    if (treeMovesName(program, tree, child, name)) return true;
  }
  return false;
}

function syntaxMovesName(
  in program: Program,
  in expression: ExpressionSyntax,
  in name: String
): boolean {
  return match (in expression.tree) {
    some(tree) => {
      const root = tree.root;
      select treeMovesName(program, tree, root, name);
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
  in arena: StatementArena,
  in name: String
): boolean {
  for (const statement of arena.nodes) {
    if (statementMovesName(program, arena, statement, name)) return true;
  }
  return false;
}

function statementMovesName(
  in program: Program,
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
      if (syntaxMovesName(program, expression, name)) return true;
    }
    none => {}
  }
  match (in statement.secondExpression) {
    some(expression) => {
      if (
        statement.kind == StatementKind.assignmentStatement
        && syntaxIsIdentifier(expression, name)
      ) return true;
      if (syntaxMovesName(program, expression, name)) return true;
    }
    none => {}
  }
  for (const child of statement.children) {
    if (statementMovesName(program, arena, arena.nodes[child], name)) {
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

function planCleanupStatement(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in arena: StatementArena,
  in ownerName: String,
  sourceIndex: usize,
  loweredIndex: usize,
  in live: Array<LoweredCleanup>,
  inout statements: Array<LoweredStatement>,
  inout liveFlags: Array<LoweredLiveFlag>,
  insideLoop: boolean,
  in loopCleanups: Array<LoweredCleanup>
): void throws String {
  if (statements[loweredIndex].kind == LoweredStatementKind.returnStatement) {
    appendStatementCleanupCopies(inout statements, loweredIndex, live);
    return;
  }
  if (statements[loweredIndex].kind == LoweredStatementKind.tryStatement) {
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
      arena,
      ownerName,
      sourceIndex,
      loweredMatch,
      initializerLive,
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
                arena,
                ownerName,
                sourceRoots,
                loweredRoots,
                armLive,
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
      arena,
      ownerName,
      sourceChildren,
      loweredChildren,
      live,
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
        arena,
        ownerName,
        sourceChild,
        loweredChild,
        live,
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
  in arena: StatementArena,
  in ownerName: String,
  in sourceRoots: Array<usize>,
  in loweredRoots: Array<usize>,
  in inherited: Array<LoweredCleanup>,
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
          if (moduleTypeNeedsCleanup(program, importedTypes, ownedType)) {
            const moved = arenaMovesName(
              program,
              arena,
              arena.nodes[sourceIndex].name
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
      arena,
      ownerName,
      sourceIndex,
      loweredIndex,
      live,
      inout statements,
      inout liveFlags,
      insideLoop,
      loopCleanups
    );
    rootIndex = rootIndex + 1;
  }
  return introduced;
}

function attachMoveLiveFlags(
  inout expressions: Array<LoweredExpression>,
  in liveFlags: Array<LoweredLiveFlag>
): void {
  let index: usize = 0;
  while (index < expressions.length) {
    if (
      expressions[index].kind == LoweredExpressionKind.moveValue
      && expressions[index].children.length == 1
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
    ) return Option.some(resolution.targetName.copyBytes(
      0,
      resolution.targetName.byteLength
    ));
  }
  return Option<String>.none;
}

function lowerParameterMode(mode: ParameterMode): LoweredParameterMode {
  if (mode == ParameterMode.input) return LoweredParameterMode.input;
  if (mode == ParameterMode.output) return LoweredParameterMode.output;
  if (mode == ParameterMode.inputOutput) {
    return LoweredParameterMode.inputOutput;
  }
  return LoweredParameterMode.value;
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
      if (name == "u8" || name == "usize" || name == "i32") return name;
    }
    none => {}
  }
  let candidate = "i32";
  for (const child of tree.nodes[index].children) {
    match (resolvedExpressionTypeName(evidence, tree, child)) {
      some(name) => {
        if (name == "usize") return name;
        if (name == "u8") candidate = move name;
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
          if (name == "usize") return name;
          if (name == "u8") candidate = move name;
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
      importedTypes[importedIndex].kind == LoweredTypeKind.structType
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
  if (tree.nodes[index].kind == ExpressionKind.identifierExpression) {
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

function lowerExpression(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize,
  inout output: Array<LoweredExpression>
): usize throws String {
  if (tree.nodes[index].kind == ExpressionKind.identifierExpression) {
    const kind = tree.nodes[index].value == "this"
      ? LoweredExpressionKind.receiverValue
      : LoweredExpressionKind.localValue;
    return pushExpression(
      inout output,
      kind,
      tree.nodes[index].value,
      Array<usize>(),
      Array<String>()
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
    else if (
      tree.nodes[index].value != "!"
      && tree.nodes[index].value != "+"
      && tree.nodes[index].value != "~"
      && tree.nodes[index].value != "move"
      && tree.nodes[index].value != "copy"
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
      Array<String>()
    );
  }
  if (tree.nodes[index].kind == ExpressionKind.conditionalExpression) {
    if (tree.nodes[index].children.length != 3) {
      throw "native lowering received a malformed conditional expression";
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
  if (tree.nodes[index].kind == ExpressionKind.callExpression) {
    if (tree.nodes[index].children.length == 0) {
      throw "native lowering received a malformed call expression";
    }
    const calleeInput = tree.nodes[index].children[0];
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
        tree.nodes[calleeInput].value == "byteAt"
        || tree.nodes[calleeInput].value == "copyBytes"
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
            Array<String>()
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
            Array<String>()
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
      && tree.nodes[index].children.length == 2
    ) {
      let constructionName = "";
      match (importedStructTarget(
        importedTypes,
        tree.nodes[calleeInput].value
      )) {
        some(name) => constructionName = move name;
        none => match (structIndex(program, tree.nodes[calleeInput].value)) {
          some(_) => constructionName = tree.nodes[calleeInput].value.copyBytes(
            0,
            tree.nodes[calleeInput].value.byteLength
          );
          none => {}
        }
      }
      if (constructionName.byteLength > 0) {
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
              value = try lowerExpressionExpected(
                program,
                importedTypes,
                evidence,
                tree,
                valueInput,
                expectedTypeName,
                inout output
              );
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
          return pushExpression(
            inout output,
            LoweredExpressionKind.structValue,
            constructionName,
            children,
            labels
          );
      }
    }
    let callee: usize = 0;
    let standardTarget = "";
    match (resolvedCallTarget(evidence, tree, index)) {
      some(target) => {
        if (
          target == "fs.readText"
          || target == "fs.writeText"
          || target == "fs.exists"
          || target == "fs.isDirectory"
          || target == "fs.realPath"
          || target == "process.args"
          || target == "process.run"
          || target == "console.log"
          || target == "console.write"
          || target == "console.error"
          || target == "console.debug"
        ) standardTarget = move target;
      }
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
      children.push(value);
      argument = argument + 1;
    }
    return pushExpression(
      inout output,
      LoweredExpressionKind.directCall,
      "",
      children,
      parameterModes
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
    const receiverType = try lowerModuleTypeName(
      program,
      importedTypes,
      receiverTypeName
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
    return pushExpression(
      inout output,
      LoweredExpressionKind.arrayIndex,
      receiverType.name,
      children,
      Array<String>()
    );
  }
  if (tree.nodes[index].kind == ExpressionKind.memberExpression) {
    if (tree.nodes[index].children.length != 1) {
      throw "native lowering received a malformed member expression";
    }
    const receiverInput = tree.nodes[index].children[0];
    if (tree.nodes[index].value == "length") {
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
            let children = Array<usize>();
            children.push(receiver);
            return pushExpression(
              inout output,
              LoweredExpressionKind.arrayLength,
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
      tree.nodes[index].value == "byteLength"
      || tree.nodes[index].value == "isEmpty"
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
      if (tree.nodes[index].value == "byteLength") {
        return pushExpression(
          inout output,
          LoweredExpressionKind.stringLength,
          "",
          children,
          Array<String>()
        );
      }
      if (tree.nodes[index].value == "isEmpty") {
        return pushExpression(
          inout output,
          LoweredExpressionKind.stringIsEmpty,
          "",
          children,
          Array<String>()
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
    return pushExpression(
      inout output,
      LoweredExpressionKind.fieldValue,
      tree.nodes[index].value,
      children,
      Array<String>()
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
  return LoweredEnum({
    name: loweredName.name.copyBytes(0, loweredName.name.byteLength),
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
  index: usize
): Option<LoweredEnum> throws String {
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
          attempted
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
              attempted
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
                attempted
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
              const innerResult = try directThrowingCallResult(
                program,
                importedTypes,
                evidence,
                tree,
                attempted
              );
              const inner = match (innerResult) {
                some(declaration) => declaration;
                none => throw "native try lowering requires one direct throwing function call yet";
              };
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
  in declaration: FunctionDeclaration
): LoweredFunction throws String {
  if (declaration.asynchronous) {
    throw `native lowering does not support async function ${declaration.name} yet`;
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
    if (
      parameter.mode == ParameterMode.value
      && moduleTypeNeedsCleanup(program, importedTypes, parameterType)
    ) {
      const moved = arenaMovesName(
        program,
        declaration.body,
        parameter.name
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
    parameters.push(LoweredParameter({
      name: parameter.name.copyBytes(0, parameter.name.byteLength),
      type: move parameterType,
      mode: lowerParameterMode(parameter.mode),
    }));
  }
  let expressions = Array<LoweredExpression>();
  let statements = Array<LoweredStatement>();
  let sourceRoots = Array<usize>();
  let roots = Array<usize>();
  for (const root of declaration.body.roots) {
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
    roots.push(loweredRoot);
  }
  const rootLoopCleanups = Array<LoweredCleanup>();
  const introduced = try planCleanupSequence(
    program,
    importedTypes,
    declaration.body,
    declaration.name,
    sourceRoots,
    roots,
    ownedParameters,
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
    body,
    `${ownerName}.deinit`,
    sourceRoots,
    roots,
    inherited,
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
  in parsed: Array<ParsedModule>
): Array<String> {
  let names = Array<String>();
  for (const module of parsed) {
    for (const declaration of module.program.functions) {
      if (containsName(names, declaration.name)) continue;
      let count: usize = 0;
      let exportedCount: usize = 0;
      for (const candidateModule of parsed) {
        for (const candidate of candidateModule.program.functions) {
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

function typeIsExported(
  in program: Program,
  in name: String
): boolean {
  for (const declaration of program.declarations) {
    if (
      (
        declaration.kind == DeclarationKind.structDeclaration
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
              labels: Array<String>(),
            });
          }
        }
      }
    }
    index = index + 1;
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
      }));
    }
  }
  return fields;
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
          types.push(LoweredImportedType({
            localName: symbol.name.copyBytes(0, symbol.name.byteLength),
            targetName,
            kind: LoweredTypeKind.structType,
            needsDeinit,
            fields,
            variants: Array<LoweredVariant>(),
            payloadBearing: false,
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
            needsDeinit: declaration.needsDeinit,
            fields: Array<LoweredField>(),
            variants,
            payloadBearing: declaration.payloadBearing,
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
      if (symbol.kind == ModuleSymbolKind.structSymbol) {
        match (loweredStructCleanup(structs, symbol.name)) {
          some(needsDeinit) => {
            const fields = loweredStructFields(structs, symbol.name);
            types.push(LoweredImportedType({
              localName: symbol.name.copyBytes(0, symbol.name.byteLength),
              targetName: symbol.name.copyBytes(0, symbol.name.byteLength),
              kind: LoweredTypeKind.structType,
              needsDeinit,
              fields,
              variants: Array<LoweredVariant>(),
              payloadBearing: false,
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
              needsDeinit: declaration.needsDeinit,
              fields: Array<LoweredField>(),
              variants,
              payloadBearing: declaration.payloadBearing,
            }));
          }
          none => {}
        }
      }
    }
  }
  return types;
}

function appendLoweredProgram(
  in program: Program,
  inout importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in privateFunctionCollisionNames: Array<String>,
  in privateTypeCollisionNames: Array<String>,
  moduleIndex: usize,
  entryIndex: usize,
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
      needsDeinit: false,
      fields: Array<LoweredField>(),
      variants: Array<LoweredVariant>(),
      payloadBearing: false,
    }));
  }
  for (const aggregate of program.aggregates) {
    if (
      aggregate.kind != DeclarationKind.structDeclaration
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
      kind: LoweredTypeKind.structType,
      needsDeinit: false,
      fields: Array<LoweredField>(),
      variants: Array<LoweredVariant>(),
      payloadBearing: false,
    }));
  }

  try collectIntrinsicEnums(
    program,
    importedTypes,
    evidence,
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
    let importedVariants = Array<LoweredVariant>();
    for (const variant of variants) {
      importedVariants.push(copyLoweredVariant(variant));
    }
    enums.push(LoweredEnum({
      name: emittedName.copyBytes(0, emittedName.byteLength),
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
      needsDeinit,
      fields: Array<LoweredField>(),
      variants: importedVariants,
      payloadBearing,
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
    const aggregateIndex = match (structIndex(program, aggregate.name)) {
      some(index) => index;
      none => throw `native lowering lost aggregate ${aggregate.name}`;
    };
    const needsDeinit = moduleAggregateNeedsCleanup(
      program,
      importedTypes,
      aggregateIndex,
      0
    );
    structs.push(LoweredStruct({
      name: emittedName,
      fields,
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
          targetName: emittedName,
          kind: LoweredTypeKind.structType,
          needsDeinit,
          fields,
          variants: Array<LoweredVariant>(),
          payloadBearing: false,
        }));
      }
      none => {}
    }
  }

  for (const declaration of program.functions) {
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
      declaration
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
    if (privateFunctionNeedsMangle(
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
  let arrays = Array<LoweredArray>();
  let maps = Array<LoweredMap>();
  let sets = Array<LoweredSet>();
  let importedTypes = Array<LoweredImportedType>();
  const privateCollisionNames = Array<String>();
  const privateTypeCollisionNames = Array<String>();
  try appendLoweredProgram(
    program,
    inout importedTypes,
    evidence,
    privateCollisionNames,
    privateTypeCollisionNames,
    0,
    0,
    inout arrays,
    inout maps,
    inout sets,
    inout structs,
    inout enums,
    inout functions
  );
  return LoweredProgram({ arrays, maps, sets, structs, enums, functions });
}

export function lowerModules(
  in parsed: Array<ParsedModule>,
  in graph: ModuleGraph
): LoweredProgram throws String {
  let structs = Array<LoweredStruct>();
  let enums = Array<LoweredEnum>();
  let functions = Array<LoweredFunction>();
  let arrays = Array<LoweredArray>();
  let maps = Array<LoweredMap>();
  let sets = Array<LoweredSet>();
  const privateFunctionCollisionNames = collisionSafePrivateFunctionNames(parsed);
  const privateTypeCollisionNames = collisionSafePrivateTypeNames(parsed);
  const entryIndex = graph.entry;
  for (const moduleIndex of graph.dependencyOrder) {
    let importedTypes = importedTypesForModule(
      graph,
      structs,
      enums,
      moduleIndex
    );
    const moduleOutcome = attempt appendLoweredProgram(
      parsed[moduleIndex].program,
      inout importedTypes,
      graph.modules[moduleIndex].semanticEvidence,
      privateFunctionCollisionNames,
      privateTypeCollisionNames,
      moduleIndex,
      entryIndex,
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
  return LoweredProgram({ arrays, maps, sets, structs, enums, functions });
}
