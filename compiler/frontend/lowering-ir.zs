// Typed, target-neutral lowering boundary between native semantics and C text.
//
// The parser AST preserves source structure. This IR instead records settled
// operations: checked arithmetic is no longer an operator string, and aggregate
// construction is no longer a call-shaped syntax node. Cleanup plans will join
// this representation when ownership-bearing aggregates land.

import {
  ArrayBindingKind,
  ConstructorDeclaration,
  DeclarationKind,
  ExpressionKind,
  ExpressionSyntax,
  ExpressionTree,
  FieldDeclaration,
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
  ModuleCallResolution,
  ModuleForeignArgument,
  ModuleForeignUnionMatch,
  ModuleFieldSignature,
  ModuleFunctionSignature,
  ModuleObjCProtocolMethodResolution,
  ModuleSemanticEvidence,
  ModuleSymbolKind,
  ModuleTypeIdentity,
  ModuleTypeSignature,
} from "./semantic-model.zs";
import {
  fixedArrayShape,
  genericTypeShape,
  nativeFunctionSignature,
  nullableTargetType,
  qualifiedTypeMember,
} from "./semantic-type-shapes.zs";
import {
  NativeValueBinding,
  addValueBinding,
} from "./semantic-flow-state.zs";
import {
  substituteGenericType,
  typeHasCleanup,
  typeIsThreadShareable,
  typeIsThreadTransferable,
} from "./semantic-type-ownership.zs";
import {
  collectTypeIdentities,
  rebaseTypeName,
  semanticTypeIdentity,
  transparentTypeName,
  typeSymbolLocation,
} from "./semantic-type-identities.zs";
import { typeExpressionName } from "./semantic-member-lookups.zs";
import { Map, Set } from "std/collections";
import fs from "std/fs";
import { TextBuffer } from "std/text";
import { internalBackendFailure } from "./native-backend-errors.zs";
import {
  directoryName,
  normalizedModulePath,
} from "./module-paths.zs";

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
  arenaType,
  hasherType,
  stringType,
  staticBytesType,
  cstringType,
  fixedArrayType,
  arrayType,
  sliceType,
  mapType,
  setType,
  structType,
  classType,
  weakType,
  onceType,
  onceLifetimeType,
  mutexType,
  taskType,
  taskScopeType,
  taskControlType,
  enumType,
  foreignEnumType,
  foreignStructType,
  foreignHandleType,
  foreignObjCType,
  functionType,
}

export struct LoweredType {
  kind: LoweredTypeKind;
  name: String;
}

export struct LoweredField {
  name: String;
  type: LoweredType;
  optionalField: boolean;
  borrowedView: boolean;
  defaultTarget: String;
  classProperty: boolean = false;
  objectiveCGetter: String = "";
  objectiveCSetter: String = "";
}

export struct LoweredStruct {
  name: String;
  nativeCName: String;
  fields: Array<LoweredField>;
  referenceType: boolean;
  executorBound: boolean;
  threadShareable: boolean;
  workerDestructible: boolean;
  needsDeinit: boolean;
  initializer: Option<LoweredFunction>;
  deinitializer: Option<LoweredFunction>;
}

export struct LoweredArray {
  name: String;
  sliceName: String;
  elementType: LoweredType;
}

export struct LoweredFixedArray {
  name: String;
  sliceName: String;
  elementType: LoweredType;
  length: String;
}

export struct LoweredSlice {
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

export struct LoweredFunctionType {
  name: String;
  asynchronous: boolean;
  parameters: Array<LoweredParameter>;
  returnType: LoweredType;
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
  foreignCallbackValue,
  parameterValue,
  receiverValue,
  integerValue,
  stringValue,
  cstringProjection,
  booleanValue,
  nullValue,
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
  emptyValue,
  retainValue,
  weakValue,
  weakUpgrade,
  viewProjection,
  borrowedTemporary,
  unaryOperation,
  binaryOperation,
  conditionalValue,
  optionalFieldValue,
  optionalCallValue,
  optionFromNullable,
  directCall,
  functionCall,
  asyncFunctionAwait,
  asyncFunctionTask,
  directFunctionValue,
  closureValue,
  methodCall,
  objectiveCMessageCall,
  objectiveCDataCopy,
  objectiveCDataBorrow,
  objectiveCInstanceOf,
  objectiveCStringFromZ,
  objectiveCStringToZ,
  objectiveCProtocolAdapter,
  objectiveCRegistration,
  fieldValue,
  structValue,
  moveStructSpreadValue,
  foreignStructValue,
  classValue,
  taskScopeValue,
  taskScopeSchedule,
  taskScopeClose,
  taskControlCancel,
  mutexValue,
  mutexWithLock,
  objectiveCAutoreleasePool,
  arenaNew,
  arenaCreate,
  arenaReset,
  memoryReplace,
  onceEmpty,
  onceInitialize,
  onceGet,
  onceState,
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
  arrayValue,
  fixedArrayValue,
  arrayRequireLength,
  arrayLength,
  fixedArrayLength,
  staticBytesIndex,
  staticBytesSlice,
  arrayIndex,
  arrayMutableIndex,
  arraySlice,
  arrayPush,
  mapEmpty,
  mapLength,
  mapHas,
  mapGet,
  mapSet,
  mapRemove,
  mapDelete,
  mapClear,
  setEmpty,
  setLength,
  setHas,
  setAdd,
  setRemove,
  setDelete,
  setClear,
  textBufferEmpty,
  textBufferAppend,
  textBufferAppendBytes,
  textBufferAppendAscii,
  textBufferAppendCodePoint,
  hasherAdd,
}

export struct LoweredExpression {
  kind: LoweredExpressionKind;
  value: String;
  children: Array<usize>;
  statements: Array<usize>;
  labels: Array<String>;
  captureBindingOffsets: Array<usize> = Array<usize>();
  captureTypes: Array<LoweredType> = Array<LoweredType>();
  moveSpreadOverrides: Array<LoweredField> = Array<LoweredField>();
  threadSafe: boolean = false;
  closureBlockBody: boolean = false;
  closureParameterCount: usize = 0;
  closureParameterModes: Array<String> = Array<String>();
  objectiveCBlockNativeType: String = "";
}

export struct LoweredMainDelaySegment {
  roots: Array<usize>;
  milliseconds: String;
}

export struct LoweredMainDelayIf {
  statement: usize;
  prefixRoots: Array<usize>;
  condition: usize;
  thenBlock: usize;
  thenSegments: Array<LoweredMainDelaySegment>;
  thenRoots: Array<usize>;
  elseBlock: Option<usize>;
  elseSegments: Array<LoweredMainDelaySegment>;
  elseRoots: Array<usize>;
}

export struct LoweredMainDelayMatchArm {
  arm: usize;
  block: usize;
  segments: Array<LoweredMainDelaySegment>;
  roots: Array<usize>;
}

export struct LoweredMainDelayMatch {
  statement: usize;
  prefixRoots: Array<usize>;
  subject: usize;
  subjectType: LoweredType;
  arms: Array<LoweredMainDelayMatchArm>;
}

export struct LoweredMainDelayLoop {
  statement: usize;
  prefixRoots: Array<usize>;
  condition: usize;
  block: usize;
  segments: Array<LoweredMainDelaySegment>;
  roots: Array<usize>;
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
  delayStatement,
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
  foreignMatchDiscriminant: String = "";
  foreignMatchMember: String = "";
  foreignMatchValues: Array<String> = Array<String>();
  foreignMatchFallback: boolean = false;
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
  compilerIntrinsic: String = "";
  compilerIntrinsicType: Option<LoweredType> = Option<LoweredType>.none;
  rawLanguage: String = "";
  rawSource: String = "";
  rawLine: usize = 0;
  rawColumn: usize = 0;
  asynchronous: boolean;
  asyncSuspension: String;
  mainDelaySegments: Array<LoweredMainDelaySegment>;
  mainDelayIfs: Array<LoweredMainDelayIf>;
  mainDelayMatches: Array<LoweredMainDelayMatch>;
  mainDelayLoops: Array<LoweredMainDelayLoop>;
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
  parameterModes: Array<String>;
  arguments: Array<ModuleForeignArgument>;
  successValues: Array<String>;
}

export struct LoweredForeignResource {
  storageName: String;
  nativeTypeName: String;
  releaseName: String;
  handle: boolean;
}

export struct LoweredObjCProtocolMethod {
  selector: String;
  nativeReturnType: String;
  nativeParameterTypes: Array<String>;
  targetName: String;
}

export struct LoweredObjCProtocolAdapter {
  name: String;
  ownerType: String;
  protocolNativeNames: Array<String>;
  methods: Array<LoweredObjCProtocolMethod>;
}

export struct LoweredObjCAdapterFactory {
  helperName: String;
  adapterName: String;
  ownerType: String;
  protocolNativeName: String;
}

export struct LoweredObjCRegistration {
  offset: usize;
  helperName: String;
  receiverNativeType: String;
  adapterName: String;
  ownerType: String;
  addSelector: String;
  addParameterNativeTypes: Array<String>;
  handlerParameter: usize;
  removeSelector: String;
  removeParameterNativeTypes: Array<String>;
  removeArgumentSources: Array<usize>;
}

export struct LoweredConstant {
  name: String;
  type: LoweredType;
  initializerKind: LoweredExpressionKind;
  value: String;
  embeddedLength: usize = 0;
}

export struct LoweredEmbeddedBytes {
  name: String;
  sourcePath: String;
  bytes: Array<u8>;
}

export struct LoweredProgram {
  foreignHeaders: Array<String>;
  foreignFunctions: Array<LoweredForeignFunction>;
  foreignResources: Array<LoweredForeignResource>;
  objectiveCProtocolAdapters: Array<LoweredObjCProtocolAdapter>;
  objectiveCAdapterFactories: Array<LoweredObjCAdapterFactory>;
  objectiveCRegistrations: Array<LoweredObjCRegistration>;
  embeddedBytes: Array<LoweredEmbeddedBytes>;
  constants: Array<LoweredConstant>;
  fixedArrays: Array<LoweredFixedArray>;
  arrays: Array<LoweredArray>;
  slices: Array<LoweredSlice>;
  maps: Array<LoweredMap>;
  sets: Array<LoweredSet>;
  functionTypes: Array<LoweredFunctionType>;
  structs: Array<LoweredStruct>;
  enums: Array<LoweredEnum>;
  functions: Array<LoweredFunction>;
}

function collectForeignResources(
  in importedTypes: Array<LoweredImportedType>,
  inout resources: Array<LoweredForeignResource>
): void throws String {
  for (const imported of importedTypes) {
    if (
      imported.resourceRelease.byteLength == 0
      && imported.kind != LoweredTypeKind.foreignHandleType
    ) continue;
    let present = false;
    for (const resource of resources) {
      if (resource.storageName != imported.targetName) continue;
      if (resource.releaseName != imported.resourceRelease) {
        throw `native resource ${imported.targetName} has conflicting cleanup functions`;
      }
      present = true;
    }
    if (present) continue;
    resources.push(LoweredForeignResource({
      storageName: imported.targetName.copyBytes(
        0,
        imported.targetName.byteLength
      ),
      nativeTypeName: imported.nativeTypeName.copyBytes(
        0,
        imported.nativeTypeName.byteLength
      ),
      releaseName: imported.resourceRelease.copyBytes(
        0,
        imported.resourceRelease.byteLength
      ),
      handle: imported.kind == LoweredTypeKind.foreignHandleType,
    }));
  }
}

function objectiveCRegistrationHelperName(
  moduleIndex: usize,
  offset: usize
): String {
  return `z_stage1_objc_register_${moduleIndex}_${offset}`;
}

function objectiveCAdapterHelperName(
  moduleIndex: usize,
  offset: usize
): String {
  return `z_stage1_objc_adapt_${moduleIndex}_${offset}`;
}

function collectObjectiveCProtocolAdapter(
  in parsed: Array<ParsedModule>,
  in graph: ModuleGraph,
  in privateTypeCollisionNames: Array<String>,
  ownerModuleIndex: usize,
  ownerSymbolIndex: usize,
  in protocolNativeNames: Array<String>,
  in protocolMethods: Array<ModuleObjCProtocolMethodResolution>,
  inout adapters: Array<LoweredObjCProtocolAdapter>
): String throws String {
  if (
    ownerModuleIndex >= parsed.length
    || ownerSymbolIndex >= graph.modules[ownerModuleIndex].symbols.length
  ) throw "native Objective-C adaptation lost its Z protocol owner";
  const ownerSourceName = view graph.modules[ownerModuleIndex].symbols[
    ownerSymbolIndex
  ].name;
  const ownerEmittedName = privateTypeNeedsMangle(
    parsed[ownerModuleIndex].program,
    privateTypeCollisionNames,
    ownerSourceName
  )
    ? emittedPrivateTypeName(ownerModuleIndex, ownerSourceName)
    : ownerSourceName.copyBytes(0, ownerSourceName.byteLength);
  const adapterName = `ZObjCProtocolAdapter_${ownerEmittedName}`;
  for (const existing of adapters) {
    if (existing.name == adapterName) return adapterName;
  }
  let protocols = Array<String>();
  for (const protocol of protocolNativeNames) {
    protocols.push(protocol.copyBytes(0, protocol.byteLength));
  }
  let methods = Array<LoweredObjCProtocolMethod>();
  for (const method of protocolMethods) {
    let parameterTypes = Array<String>();
    for (const parameterType of method.nativeParameterTypes) {
      parameterTypes.push(parameterType.copyBytes(
        0,
        parameterType.byteLength
      ));
    }
    methods.push(LoweredObjCProtocolMethod({
      selector: method.selector.copyBytes(0, method.selector.byteLength),
      nativeReturnType: method.nativeReturnType.copyBytes(
        0,
        method.nativeReturnType.byteLength
      ),
      nativeParameterTypes: parameterTypes,
      targetName: `Z_${ownerEmittedName}_${method.targetName}`,
    }));
  }
  adapters.push(LoweredObjCProtocolAdapter({
    name: adapterName.copyBytes(0, adapterName.byteLength),
    ownerType: ownerEmittedName.copyBytes(0, ownerEmittedName.byteLength),
    protocolNativeNames: protocols,
    methods,
  }));
  return adapterName;
}

function collectObjectiveCRegistrations(
  in parsed: Array<ParsedModule>,
  in graph: ModuleGraph,
  in privateTypeCollisionNames: Array<String>,
  moduleIndex: usize,
  inout adapters: Array<LoweredObjCProtocolAdapter>,
  inout adapterFactories: Array<LoweredObjCAdapterFactory>,
  inout registrations: Array<LoweredObjCRegistration>
): void throws String {
  for (const plan of graph.modules[moduleIndex].semanticEvidence
    .objectiveCRegistrations) {
    if (
      plan.ownerModuleIndex >= parsed.length
      || plan.ownerSymbolIndex
        >= graph.modules[plan.ownerModuleIndex].symbols.length
    ) throw "native Objective-C registration lost its Z protocol owner";
    const ownerSourceName = view graph.modules[plan.ownerModuleIndex].symbols[
      plan.ownerSymbolIndex
    ].name;
    const ownerEmittedName = privateTypeNeedsMangle(
      parsed[plan.ownerModuleIndex].program,
      privateTypeCollisionNames,
      ownerSourceName
    )
      ? emittedPrivateTypeName(plan.ownerModuleIndex, ownerSourceName)
      : ownerSourceName.copyBytes(0, ownerSourceName.byteLength);
    const adapterName = try collectObjectiveCProtocolAdapter(
      parsed,
      graph,
      privateTypeCollisionNames,
      plan.ownerModuleIndex,
      plan.ownerSymbolIndex,
      plan.protocolNativeNames,
      plan.protocolMethods,
      inout adapters
    );
    let addParameterTypes = Array<String>();
    for (const parameterType of plan.addParameterNativeTypes) {
      addParameterTypes.push(parameterType.copyBytes(
        0,
        parameterType.byteLength
      ));
    }
    let removeParameterTypes = Array<String>();
    for (const parameterType of plan.removeParameterNativeTypes) {
      removeParameterTypes.push(parameterType.copyBytes(
        0,
        parameterType.byteLength
      ));
    }
    let removeSources = Array<usize>();
    for (const source of plan.removeArgumentSources) {
      removeSources.push(source);
    }
    registrations.push(LoweredObjCRegistration({
      offset: plan.offset,
      helperName: objectiveCRegistrationHelperName(
        plan.moduleIndex,
        plan.offset
      ),
      receiverNativeType: plan.receiverNativeType.copyBytes(
        0,
        plan.receiverNativeType.byteLength
      ),
      adapterName: adapterName.copyBytes(0, adapterName.byteLength),
      ownerType: ownerEmittedName.copyBytes(
        0,
        ownerEmittedName.byteLength
      ),
      addSelector: plan.addSelector.copyBytes(0, plan.addSelector.byteLength),
      addParameterNativeTypes: addParameterTypes,
      handlerParameter: plan.handlerParameter,
      removeSelector: plan.removeSelector.copyBytes(
        0,
        plan.removeSelector.byteLength
      ),
      removeParameterNativeTypes: removeParameterTypes,
      removeArgumentSources: removeSources,
    }));
  }
  for (const plan of graph.modules[moduleIndex].semanticEvidence
    .objectiveCAdapters) {
    const adapterName = try collectObjectiveCProtocolAdapter(
      parsed,
      graph,
      privateTypeCollisionNames,
      plan.ownerModuleIndex,
      plan.ownerSymbolIndex,
      plan.protocolNativeNames,
      plan.protocolMethods,
      inout adapters
    );
    const ownerSourceName = view graph.modules[plan.ownerModuleIndex].symbols[
      plan.ownerSymbolIndex
    ].name;
    const ownerEmittedName = privateTypeNeedsMangle(
      parsed[plan.ownerModuleIndex].program,
      privateTypeCollisionNames,
      ownerSourceName
    )
      ? emittedPrivateTypeName(plan.ownerModuleIndex, ownerSourceName)
      : ownerSourceName.copyBytes(0, ownerSourceName.byteLength);
    if (plan.protocolNativeNames.length != 1) {
      throw "native Objective-C adapter factory requires exactly one protocol";
    }
    adapterFactories.push(LoweredObjCAdapterFactory({
      helperName: objectiveCAdapterHelperName(plan.moduleIndex, plan.offset),
      adapterName,
      ownerType: ownerEmittedName,
      protocolNativeName: plan.protocolNativeNames[0].copyBytes(
        0,
        plan.protocolNativeNames[0].byteLength
      ),
    }));
  }
}

function safeForeignHandleName(in name: String): String {
  let output = TextBuffer();
  output.append("Z_Handle_");
  let index: usize = 0;
  while (index < name.byteLength) {
    const byte = name.byteAt(index);
    const identifier = (byte >= 48 && byte <= 57)
      || (byte >= 65 && byte <= 90)
      || (byte >= 97 && byte <= 122)
      || byte == 95;
    if (identifier) output.appendAscii(byte);
    else output.appendAscii(95);
    index = index + 1;
  }
  return output.finish();
}

struct LoweredImportedType {
  localName: String;
  targetName: String;
  nativeTypeName: String;
  kind: LoweredTypeKind;
  executorBound: boolean;
  threadShareable: boolean;
  workerDestructible: boolean;
  needsDeinit: boolean;
  resourceRelease: String;
  fields: Array<LoweredField>;
  variants: Array<LoweredVariant>;
  payloadBearing: boolean;
  underlyingType: String;
}

struct LoweredGenericStructField {
  name: String;
  typeName: String;
  optionalField: boolean;
  hasDefault: boolean;
  borrowedView: boolean;
}

struct LoweredGenericStructUse {
  consumerModuleIndex: usize;
  ownerModuleIndex: usize;
  ownerName: String;
  sourceName: String;
  emittedName: String;
  typeParameters: Array<String>;
  typeArguments: Array<String>;
  typeArgumentModules: Array<usize>;
  typeArgumentSymbols: Array<usize>;
  fields: Array<LoweredGenericStructField>;
  customDeinit: boolean;
  referenceType: boolean;
  executorBound: boolean;
}

struct LoweredGenericMethodUse {
  consumerModuleIndex: usize;
  ownerModuleIndex: usize;
  ownerSymbolIndex: usize;
  ownerName: String;
  methodName: String;
  ownerTypeArguments: Array<String>;
  methodTypeParameters: Array<String>;
  methodTypeArguments: Array<String>;
  allTypeArguments: Array<String>;
  allTypeArgumentIdentities: Array<String>;
  typeArgumentModules: Array<usize>;
  typeArgumentSymbols: Array<usize>;
}

struct LoweredGenericFunctionUse {
  consumerModuleIndex: usize;
  ownerModuleIndex: usize;
  ownerSymbolIndex: usize;
  name: String;
  typeParameters: Array<String>;
  typeArguments: Array<String>;
  typeArgumentIdentities: Array<String>;
  typeArgumentModules: Array<usize>;
  typeArgumentSymbols: Array<usize>;
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

function functionIdentityHexDigit(value: u8): u8 {
  if (value < 10) return 48 + value;
  return 87 + value;
}

function encodedFunctionTypeIdentity(in identity: String): String {
  let output = TextBuffer();
  output.append("Function_");
  let index: usize = 0;
  while (index < identity.byteLength) {
    const byte = identity.byteAt(index);
    output.appendAscii(functionIdentityHexDigit(byte >> 4));
    output.appendAscii(functionIdentityHexDigit(byte & 15));
    index = index + 1;
  }
  return output.finish();
}

function encodedGenericStructName(
  ownerModuleIndex: usize,
  ownerSymbolIndex: usize,
  in identity: String
): String {
  let output = TextBuffer();
  output.append(`__z_mono_${ownerModuleIndex}_${ownerSymbolIndex}_`);
  let index: usize = 0;
  while (index < identity.byteLength) {
    const byte = identity.byteAt(index);
    output.appendAscii(functionIdentityHexDigit(byte >> 4));
    output.appendAscii(functionIdentityHexDigit(byte & 15));
    index = index + 1;
  }
  return output.finish();
}

function genericCallableSpecializationSuffix(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in typeArguments: Array<String>
): String throws String {
  let identity = TextBuffer();
  for (const argument of typeArguments) {
    const concrete = try lowerModuleTypeName(
      program,
      importedTypes,
      argument
    );
    identity.append(loweredTypeIdentity(concrete));
    identity.append(";");
  }
  const canonical = identity.finish();
  const encoded = encodedFunctionTypeIdentity(canonical);
  return `__${encoded}`;
}

function genericTypeIdentityPath(in path: String, in segment: String): String {
  if (path.byteLength == 0) return segment.copyBytes(0, segment.byteLength);
  return `${path}/${segment}`;
}

function typeIdentityAtPath(
  in identities: Array<ModuleTypeIdentity>,
  in path: String
): Option<ModuleTypeIdentity> {
  for (const identity of identities) {
    if (identity.path != path) continue;
    return Option.some(ModuleTypeIdentity({
      path: identity.path.copyBytes(0, identity.path.byteLength),
      targetModuleIndex: identity.targetModuleIndex,
      targetSymbolIndex: identity.targetSymbolIndex,
    }));
  }
  return Option<ModuleTypeIdentity>.none;
}

function canonicalGenericTypeIdentity(
  in typeName: String,
  in identities: Array<ModuleTypeIdentity>,
  in path: String
): String {
  match (genericTypeShape(typeName)) {
    some(generic) => {
      let output = TextBuffer();
      match (typeIdentityAtPath(identities, path)) {
        some(identity) => output.append(
          `@${identity.targetModuleIndex}:${identity.targetSymbolIndex}`
        );
        none => output.append(generic.base);
      }
      output.append("<");
      let argumentIndex: usize = 0;
      while (argumentIndex < generic.arguments.length) {
        if (argumentIndex > 0) output.append(",");
        const childPath = genericTypeIdentityPath(
          path,
          `${argumentIndex}`
        );
        const argument = canonicalGenericTypeIdentity(
          generic.arguments[argumentIndex],
          identities,
          childPath
        );
        output.append(argument);
        argumentIndex = argumentIndex + 1;
      }
      output.append(">");
      return output.finish();
    }
    none => {}
  }
  const nullable = nullableTargetType(typeName);
  if (nullable.byteLength > 0) {
    const childPath = genericTypeIdentityPath(path, "0");
    const target = canonicalGenericTypeIdentity(
      nullable,
      identities,
      childPath
    );
    return `${target}|null`;
  }
  if (stringStartsWith(typeName, "view ")) {
    const targetName = typeName.copyBytes(5, typeName.byteLength);
    const childPath = genericTypeIdentityPath(path, "0");
    const target = canonicalGenericTypeIdentity(
      targetName,
      identities,
      childPath
    );
    return `view ${target}`;
  }
  if (stringStartsWith(typeName, "readonly ")) {
    const targetName = typeName.copyBytes(9, typeName.byteLength);
    const childPath = genericTypeIdentityPath(path, "0");
    const target = canonicalGenericTypeIdentity(
      targetName,
      identities,
      childPath
    );
    return `readonly ${target}`;
  }
  match (fixedArrayShape(typeName)) {
    some(array) => {
      const childPath = genericTypeIdentityPath(path, "0");
      const element = canonicalGenericTypeIdentity(
        array.elementType,
        identities,
        childPath
      );
      return `${element}[${array.length}]`;
    }
    none => {}
  }
  match (nativeFunctionSignature(typeName)) {
    some(signature) => {
      let output = TextBuffer();
      output.append("(");
      let parameterIndex: usize = 0;
      while (parameterIndex < signature.parameterTypes.length) {
        if (parameterIndex > 0) output.append(",");
        output.append(signature.parameterModes[parameterIndex]);
        output.append(":");
        const parameterPath = genericTypeIdentityPath(
          path,
          `p${parameterIndex}`
        );
        const parameterType = canonicalGenericTypeIdentity(
          signature.parameterTypes[parameterIndex],
          identities,
          parameterPath
        );
        output.append(parameterType);
        parameterIndex = parameterIndex + 1;
      }
      output.append(")=>");
      const returnPath = genericTypeIdentityPath(path, "r");
      const returnType = canonicalGenericTypeIdentity(
        signature.returnType,
        identities,
        returnPath
      );
      output.append(returnType);
      if (signature.errorType.byteLength > 0) {
        output.append(" throws ");
        const errorPath = genericTypeIdentityPath(path, "e");
        const errorType = canonicalGenericTypeIdentity(
          signature.errorType,
          identities,
          errorPath
        );
        output.append(errorType);
      }
      if (signature.threadContract.byteLength > 0) {
        output.append(" on ");
        output.append(signature.threadContract);
      }
      return output.finish();
    }
    none => {}
  }
  match (typeIdentityAtPath(identities, path)) {
    some(identity) => return
      `@${identity.targetModuleIndex}:${identity.targetSymbolIndex}`;
    none => {}
  }
  return typeName.copyBytes(0, typeName.byteLength);
}

function containsGenericStructUse(
  in uses: Array<LoweredGenericStructUse>,
  moduleIndex: usize,
  in sourceName: String
): boolean {
  for (const use of uses) {
    if (
      use.consumerModuleIndex == moduleIndex
      && use.sourceName == sourceName
    ) return true;
  }
  return false;
}

function concreteGenericTypeName(
  in base: String,
  in arguments: Array<String>
): String {
  let output = TextBuffer();
  output.append(base);
  output.append("<");
  let index: usize = 0;
  while (index < arguments.length) {
    if (index > 0) output.append(", ");
    output.append(arguments[index]);
    index = index + 1;
  }
  output.append(">");
  return output.finish();
}

function copyStrings(in values: Array<String>): Array<String> {
  let copied = Array<String>();
  for (const value of values) {
    copied.push(value.copyBytes(0, value.byteLength));
  }
  return copied;
}

function copyUsizes(in values: Array<usize>): Array<usize> {
  let copied = Array<usize>();
  for (const value of values) {
    copied.push(value);
  }
  return copied;
}

function typeContainsGenericParameter(
  in typeName: String,
  in parameters: Array<String>
): boolean {
  for (const parameter of parameters) {
    if (typeName == parameter) return true;
  }
  match (genericTypeShape(typeName)) {
    some(generic) => {
      for (const argument of generic.arguments) {
        if (typeContainsGenericParameter(argument, parameters)) return true;
      }
      return false;
    }
    none => {}
  }
  const nullable = nullableTargetType(typeName);
  if (nullable.byteLength > 0) {
    return typeContainsGenericParameter(nullable, parameters);
  }
  if (stringStartsWith(typeName, "view ")) {
    const target = typeName.copyBytes(5, typeName.byteLength);
    return typeContainsGenericParameter(target, parameters);
  }
  if (stringStartsWith(typeName, "readonly ")) {
    const target = typeName.copyBytes(9, typeName.byteLength);
    return typeContainsGenericParameter(target, parameters);
  }
  match (fixedArrayShape(typeName)) {
    some(array) => return typeContainsGenericParameter(
      array.elementType,
      parameters
    );
    none => {}
  }
  match (nativeFunctionSignature(typeName)) {
    some(signature) => {
      for (const parameterType of signature.parameterTypes) {
        if (typeContainsGenericParameter(parameterType, parameters)) {
          return true;
        }
      }
      if (typeContainsGenericParameter(signature.returnType, parameters)) {
        return true;
      }
      if (
        signature.errorType.byteLength > 0
        && typeContainsGenericParameter(signature.errorType, parameters)
      ) return true;
    }
    none => {}
  }
  return false;
}

function typeContainsNamedGenericParameter(
  in typeName: String,
  in parameter: String
): boolean {
  if (typeName == parameter) return true;
  match (genericTypeShape(typeName)) {
    some(generic) => {
      for (const argument of generic.arguments) {
        if (typeContainsNamedGenericParameter(argument, parameter)) {
          return true;
        }
      }
    }
    none => {}
  }
  const nullable = nullableTargetType(typeName);
  if (nullable.byteLength > 0) {
    return typeContainsNamedGenericParameter(nullable, parameter);
  }
  if (stringStartsWith(typeName, "view ")) {
    const target = typeName.copyBytes(5, typeName.byteLength);
    return typeContainsNamedGenericParameter(target, parameter);
  }
  if (stringStartsWith(typeName, "readonly ")) {
    const target = typeName.copyBytes(9, typeName.byteLength);
    return typeContainsNamedGenericParameter(target, parameter);
  }
  match (fixedArrayShape(typeName)) {
    some(array) => return typeContainsNamedGenericParameter(
      array.elementType,
      parameter
    );
    none => {}
  }
  return false;
}

function genericParameterHasNominalShadow(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in parameter: String
): boolean {
  match (structIndex(program, parameter)) {
    some(_) => return true;
    none => {}
  }
  match (classIndex(program, parameter)) {
    some(_) => return true;
    none => {}
  }
  match (enumIndex(program, parameter)) {
    some(_) => return true;
    none => {}
  }
  for (const imported of importedTypes) {
    if (
      imported.localName == parameter
      || imported.targetName == parameter
    ) return true;
  }
  return false;
}

function genericStructFields(
  in graph: ModuleGraph,
  ownerModuleIndex: usize,
  consumerModuleIndex: usize,
  in sourceFields: Array<ModuleFieldSignature>,
  in substitutions: Array<NativeValueBinding>
): Array<LoweredGenericStructField> {
  let fields = Array<LoweredGenericStructField>();
  for (const field of sourceFields) {
    const rebasedType = rebaseTypeName(
      graph.modules,
      ownerModuleIndex,
      consumerModuleIndex,
      field.typeName
    );
    const concreteType = substituteGenericType(
      rebasedType,
      substitutions
    );
    fields.push(LoweredGenericStructField({
      name: field.name.copyBytes(0, field.name.byteLength),
      typeName: move concreteType,
      optionalField: field.optionalField,
      hasDefault: field.hasDefault,
      borrowedView: stringStartsWith(field.typeName, "view "),
    }));
  }
  return fields;
}

function appendSubstitutedTypeArgumentIdentities(
  in sourceTypeName: String,
  in path: String,
  in typeParameters: Array<String>,
  in typeArgumentModules: Array<usize>,
  in typeArgumentSymbols: Array<usize>,
  moduleCount: usize,
  inout identities: Array<ModuleTypeIdentity>
): void {
  let parameterIndex: usize = 0;
  while (parameterIndex < typeParameters.length) {
    if (
      sourceTypeName == typeParameters[parameterIndex]
      && parameterIndex < typeArgumentModules.length
      && parameterIndex < typeArgumentSymbols.length
      && typeArgumentModules[parameterIndex] < moduleCount
    ) {
      match (typeIdentityAtPath(identities, path)) {
        some(_) => {}
        none => identities.push(ModuleTypeIdentity({
          path: path.copyBytes(0, path.byteLength),
          targetModuleIndex: typeArgumentModules[parameterIndex],
          targetSymbolIndex: typeArgumentSymbols[parameterIndex],
        }));
      }
      return;
    }
    parameterIndex = parameterIndex + 1;
  }
  match (genericTypeShape(sourceTypeName)) {
    some(generic) => {
      let argumentIndex: usize = 0;
      while (argumentIndex < generic.arguments.length) {
        const childPath = genericTypeIdentityPath(
          path,
          `${argumentIndex}`
        );
        appendSubstitutedTypeArgumentIdentities(
          generic.arguments[argumentIndex],
          childPath,
          typeParameters,
          typeArgumentModules,
          typeArgumentSymbols,
          moduleCount,
          inout identities
        );
        argumentIndex = argumentIndex + 1;
      }
      return;
    }
    none => {}
  }
  const nullable = nullableTargetType(sourceTypeName);
  if (nullable.byteLength > 0) {
    const childPath = genericTypeIdentityPath(path, "0");
    appendSubstitutedTypeArgumentIdentities(
      nullable,
      childPath,
      typeParameters,
      typeArgumentModules,
      typeArgumentSymbols,
      moduleCount,
      inout identities
    );
    return;
  }
  if (stringStartsWith(sourceTypeName, "view ")) {
    const childPath = genericTypeIdentityPath(path, "0");
    const target = sourceTypeName.copyBytes(5, sourceTypeName.byteLength);
    appendSubstitutedTypeArgumentIdentities(
      target,
      childPath,
      typeParameters,
      typeArgumentModules,
      typeArgumentSymbols,
      moduleCount,
      inout identities
    );
    return;
  }
  if (stringStartsWith(sourceTypeName, "readonly ")) {
    const childPath = genericTypeIdentityPath(path, "0");
    const target = sourceTypeName.copyBytes(9, sourceTypeName.byteLength);
    appendSubstitutedTypeArgumentIdentities(
      target,
      childPath,
      typeParameters,
      typeArgumentModules,
      typeArgumentSymbols,
      moduleCount,
      inout identities
    );
    return;
  }
  match (fixedArrayShape(sourceTypeName)) {
    some(array) => {
      const childPath = genericTypeIdentityPath(path, "0");
      appendSubstitutedTypeArgumentIdentities(
        array.elementType,
        childPath,
        typeParameters,
        typeArgumentModules,
        typeArgumentSymbols,
        moduleCount,
        inout identities
      );
    }
    none => {}
  }
}

function collectGenericStructUseFromType(
  in graph: ModuleGraph,
  consumerModuleIndex: usize,
  in typeName: String,
  in identities: Array<ModuleTypeIdentity>,
  in path: String,
  inout seen: Array<String>,
  inout uses: Array<LoweredGenericStructUse>
): void {
  const transparent = transparentTypeName(
    graph.modules,
    consumerModuleIndex,
    typeName
  );
  if (transparent != typeName) {
    let transparentIdentities = Array<ModuleTypeIdentity>();
    collectTypeIdentities(
      graph.modules,
      consumerModuleIndex,
      transparent,
      path,
      inout transparentIdentities
    );
    collectGenericStructUseFromType(
      graph,
      consumerModuleIndex,
      transparent,
      transparentIdentities,
      path,
      inout seen,
      inout uses
    );
    return;
  }
  match (genericTypeShape(typeName)) {
    some(generic) => {
      let argumentIndex: usize = 0;
      while (argumentIndex < generic.arguments.length) {
        const childPath = genericTypeIdentityPath(
          path,
          `${argumentIndex}`
        );
        collectGenericStructUseFromType(
          graph,
          consumerModuleIndex,
          generic.arguments[argumentIndex],
          identities,
          childPath,
          inout seen,
          inout uses
        );
        argumentIndex = argumentIndex + 1;
      }
      match (typeIdentityAtPath(identities, path)) {
        some(identity) => {
          if (
            identity.targetModuleIndex >= graph.modules.length
            || identity.targetSymbolIndex
              >= graph.modules[identity.targetModuleIndex].symbols.length
          ) return;
          const symbol = view graph.modules[identity.targetModuleIndex].symbols[
            identity.targetSymbolIndex
          ];
          if (
            symbol.kind != ModuleSymbolKind.structSymbol
            && symbol.kind != ModuleSymbolKind.classSymbol
          ) return;
          match (in symbol.typeSignature) {
            some(signature) => {
              let unsettledArgument = false;
              for (const argument of generic.arguments) {
                if (typeContainsGenericParameter(
                  argument,
                  signature.typeParameters
                )) unsettledArgument = true;
              }
              if (
                signature.typeParameters.length == 0
                || signature.typeParameters.length != generic.arguments.length
                || unsettledArgument
                || containsGenericStructUse(
                  uses,
                  consumerModuleIndex,
                  typeName
                )
              ) return;
              const useIdentity = `${consumerModuleIndex}:${identity.targetModuleIndex}:${identity.targetSymbolIndex}:${typeName}`;
              if (containsString(seen, useIdentity)) return;
              seen.push(move useIdentity);
              let substitutions = Array<NativeValueBinding>();
              let parameterIndex: usize = 0;
              while (parameterIndex < signature.typeParameters.length) {
                addValueBinding(
                  inout substitutions,
                  signature.typeParameters[parameterIndex],
                  generic.arguments[parameterIndex]
                );
                parameterIndex = parameterIndex + 1;
              }
              let ownerArguments = Array<String>();
              for (const argument of generic.arguments) {
                ownerArguments.push(rebaseTypeName(
                  graph.modules,
                  consumerModuleIndex,
                  identity.targetModuleIndex,
                  argument
                ));
              }
              let ownerSubstitutions = Array<NativeValueBinding>();
              let ownerParameterIndex: usize = 0;
              while (
                ownerParameterIndex < signature.typeParameters.length
              ) {
                addValueBinding(
                  inout ownerSubstitutions,
                  signature.typeParameters[ownerParameterIndex],
                  ownerArguments[ownerParameterIndex]
                );
                ownerParameterIndex = ownerParameterIndex + 1;
              }
              const fields = genericStructFields(
                graph,
                identity.targetModuleIndex,
                consumerModuleIndex,
                signature.fields,
                substitutions
              );
              const canonicalIdentity = canonicalGenericTypeIdentity(
                typeName,
                identities,
                path
              );
              const emittedName = encodedGenericStructName(
                identity.targetModuleIndex,
                identity.targetSymbolIndex,
                canonicalIdentity
              );
              let argumentModules = Array<usize>();
              let argumentSymbols = Array<usize>();
              let identityArgumentIndex: usize = 0;
              while (identityArgumentIndex < generic.arguments.length) {
                const childPath = genericTypeIdentityPath(
                  path,
                  `${identityArgumentIndex}`
                );
                match (typeIdentityAtPath(identities, childPath)) {
                  some(argumentIdentity) => {
                    argumentModules.push(argumentIdentity.targetModuleIndex);
                    argumentSymbols.push(argumentIdentity.targetSymbolIndex);
                  }
                  none => {
                    argumentModules.push(graph.modules.length);
                    argumentSymbols.push(0);
                  }
                }
                identityArgumentIndex = identityArgumentIndex + 1;
              }
              // A concrete generic aggregate can itself store another generic
              // aggregate whose type remains parameterized in the source
              // declaration. Close the owner's structural demand before the
              // containing aggregate so its completed ABI is available while
              // lowering the outer fields. Consumers then reuse that ABI;
              // they do not need to import private nested implementation types.
              for (const field of signature.fields) {
                const ownerFieldType = substituteGenericType(
                  field.typeName,
                  ownerSubstitutions
                );
                let fieldIdentities = Array<ModuleTypeIdentity>();
                collectTypeIdentities(
                  graph.modules,
                  identity.targetModuleIndex,
                  ownerFieldType,
                  "",
                  inout fieldIdentities
                );
                appendSubstitutedTypeArgumentIdentities(
                  field.typeName,
                  "",
                  signature.typeParameters,
                  argumentModules,
                  argumentSymbols,
                  graph.modules.length,
                  inout fieldIdentities
                );
                collectGenericStructUseFromType(
                  graph,
                  identity.targetModuleIndex,
                  ownerFieldType,
                  fieldIdentities,
                  "",
                  inout seen,
                  inout uses
                );
                if (consumerModuleIndex != identity.targetModuleIndex) {
                  const rebasedFieldType = rebaseTypeName(
                    graph.modules,
                    identity.targetModuleIndex,
                    consumerModuleIndex,
                    field.typeName
                  );
                  const concreteFieldType = substituteGenericType(
                    rebasedFieldType,
                    substitutions
                  );
                  collectGenericStructUseFromType(
                    graph,
                    consumerModuleIndex,
                    concreteFieldType,
                    fieldIdentities,
                    "",
                    inout seen,
                    inout uses
                  );
                }
              }
              const ownerSourceName = concreteGenericTypeName(
                symbol.name,
                ownerArguments
              );
              if (!containsGenericStructUse(
                uses,
                identity.targetModuleIndex,
                ownerSourceName
              )) {
                const ownerFields = genericStructFields(
                  graph,
                  identity.targetModuleIndex,
                  identity.targetModuleIndex,
                  signature.fields,
                  ownerSubstitutions
                );
                uses.push(LoweredGenericStructUse({
                  consumerModuleIndex: identity.targetModuleIndex,
                  ownerModuleIndex: identity.targetModuleIndex,
                  ownerName: symbol.name.copyBytes(
                    0,
                    symbol.name.byteLength
                  ),
                  sourceName: move ownerSourceName,
                  emittedName: emittedName.copyBytes(
                    0,
                    emittedName.byteLength
                  ),
                  typeParameters: copyStrings(signature.typeParameters),
                  typeArguments: move ownerArguments,
                  typeArgumentModules: copyUsizes(argumentModules),
                  typeArgumentSymbols: copyUsizes(argumentSymbols),
                  fields: move ownerFields,
                  customDeinit: signature.customDeinit,
                  referenceType: symbol.kind == ModuleSymbolKind.classSymbol,
                  executorBound: symbol.kind == ModuleSymbolKind.classSymbol
                    && signature.executorAffinity.byteLength > 0,
                }));
              }
              if (!containsGenericStructUse(
                uses,
                consumerModuleIndex,
                typeName
              )) {
                uses.push(LoweredGenericStructUse({
                  consumerModuleIndex,
                  ownerModuleIndex: identity.targetModuleIndex,
                  ownerName: symbol.name.copyBytes(
                    0,
                    symbol.name.byteLength
                  ),
                  sourceName: typeName.copyBytes(0, typeName.byteLength),
                  emittedName: emittedName.copyBytes(
                    0,
                    emittedName.byteLength
                  ),
                  typeParameters: copyStrings(signature.typeParameters),
                  typeArguments: copyStrings(generic.arguments),
                  typeArgumentModules: move argumentModules,
                  typeArgumentSymbols: move argumentSymbols,
                  fields,
                  customDeinit: signature.customDeinit,
                  referenceType: symbol.kind == ModuleSymbolKind.classSymbol,
                  executorBound: symbol.kind == ModuleSymbolKind.classSymbol
                    && signature.executorAffinity.byteLength > 0,
                }));
              }
            }
            none => {}
          }
        }
        none => {}
      }
      return;
    }
    none => {}
  }
  const nullable = nullableTargetType(typeName);
  if (nullable.byteLength > 0) {
    const childPath = genericTypeIdentityPath(path, "0");
    collectGenericStructUseFromType(
      graph,
      consumerModuleIndex,
      nullable,
      identities,
      childPath,
      inout seen,
      inout uses
    );
    return;
  }
  if (stringStartsWith(typeName, "view ")) {
    const target = typeName.copyBytes(5, typeName.byteLength);
    const childPath = genericTypeIdentityPath(path, "0");
    collectGenericStructUseFromType(
      graph,
      consumerModuleIndex,
      target,
      identities,
      childPath,
      inout seen,
      inout uses
    );
    return;
  }
  if (stringStartsWith(typeName, "readonly ")) {
    const target = typeName.copyBytes(9, typeName.byteLength);
    const childPath = genericTypeIdentityPath(path, "0");
    collectGenericStructUseFromType(
      graph,
      consumerModuleIndex,
      target,
      identities,
      childPath,
      inout seen,
      inout uses
    );
    return;
  }
  match (fixedArrayShape(typeName)) {
    some(array) => {
      const childPath = genericTypeIdentityPath(path, "0");
      collectGenericStructUseFromType(
        graph,
        consumerModuleIndex,
        array.elementType,
        identities,
        childPath,
        inout seen,
        inout uses
      );
    }
    none => {}
  }
}

function appendCallDeclarationTypeIdentities(
  in graph: ModuleGraph,
  consumerModuleIndex: usize,
  in resolution: ModuleCallResolution,
  parameterIndex: usize,
  returnType: boolean,
  inout identities: Array<ModuleTypeIdentity>
): void {
  if (
    resolution.targetModuleIndex >= graph.modules.length
    || resolution.targetSymbolIndex >= graph.modules[
      resolution.targetModuleIndex
    ].symbols.length
  ) return;
  const symbol = view graph.modules[resolution.targetModuleIndex].symbols[
    resolution.targetSymbolIndex
  ];
  let sourceType = "";
  let typeParameters = Array<String>();
  match (in symbol.typeSignature) {
    some(owner) => {
      for (const parameter of owner.typeParameters) {
        typeParameters.push(parameter.copyBytes(0, parameter.byteLength));
      }
      const methodName = qualifiedTypeMember(resolution.targetName);
      for (const method of owner.methods) {
        if (method.name != methodName) continue;
        for (const parameter of method.signature.typeParameters) {
          typeParameters.push(parameter.copyBytes(0, parameter.byteLength));
        }
        if (returnType) {
          sourceType = method.signature.returnType.copyBytes(
            0,
            method.signature.returnType.byteLength
          );
        } else if (parameterIndex < method.signature.parameterTypes.length) {
          sourceType = method.signature.parameterTypes[parameterIndex]
            .copyBytes(
              0,
              method.signature.parameterTypes[parameterIndex].byteLength
            );
        }
      }
    }
    none => match (in symbol.functionSignature) {
      some(signature) => {
        for (const parameter of signature.typeParameters) {
          typeParameters.push(parameter.copyBytes(0, parameter.byteLength));
        }
        if (returnType) {
          sourceType = signature.returnType.copyBytes(
            0,
            signature.returnType.byteLength
          );
        } else if (parameterIndex < signature.parameterTypes.length) {
          sourceType = signature.parameterTypes[parameterIndex].copyBytes(
            0,
            signature.parameterTypes[parameterIndex].byteLength
          );
        }
      }
      none => {}
    }
  }
  if (sourceType.byteLength == 0) return;
  collectTypeIdentities(
    graph.modules,
    resolution.targetModuleIndex,
    sourceType,
    "",
    inout identities
  );
  let argumentModules = Array<usize>();
  let argumentSymbols = Array<usize>();
  for (const argument of resolution.typeArguments) {
    match (typeSymbolLocation(
      graph.modules,
      consumerModuleIndex,
      argument
    )) {
      some(location) => {
        argumentModules.push(location.moduleIndex);
        argumentSymbols.push(location.symbolIndex);
      }
      none => {
        argumentModules.push(graph.modules.length);
        argumentSymbols.push(0);
      }
    }
  }
  appendSubstitutedTypeArgumentIdentities(
    sourceType,
    "",
    typeParameters,
    argumentModules,
    argumentSymbols,
    graph.modules.length,
    inout identities
  );
}

function collectGenericStructUses(
  in parsed: Array<ParsedModule>,
  in graph: ModuleGraph
): Array<LoweredGenericStructUse> {
  let uses = Array<LoweredGenericStructUse>();
  let seen = Array<String>();
  let moduleIndex: usize = 0;
  while (moduleIndex < graph.modules.length) {
    const evidence = view graph.modules[moduleIndex].semanticEvidence;
    const unsettledTypeParameters = programGenericTypeParameterNames(
      parsed[moduleIndex].program
    );
    // Concrete generic aggregates can exist only in a declaration signature
    // (for example a generated adapter marker parameter) and never appear as
    // a local binding or expression. Declaration types are first-class demand
    // roots too; otherwise native lowering learns about them only after it has
    // already tried to lower the function.
    for (const symbol of graph.modules[moduleIndex].symbols) {
      match (in symbol.functionSignature) {
        some(signature) => {
          if (signature.typeParameters.length > 0) continue;
          for (const parameterType of signature.parameterTypes) {
            if (typeContainsGenericParameter(
              parameterType,
              unsettledTypeParameters
            )) continue;
            let identities = Array<ModuleTypeIdentity>();
            collectTypeIdentities(
              graph.modules,
              moduleIndex,
              parameterType,
              "",
              inout identities
            );
            collectGenericStructUseFromType(
              graph,
              moduleIndex,
              parameterType,
              identities,
              "",
              inout seen,
              inout uses
            );
          }
          if (!typeContainsGenericParameter(
            signature.returnType,
            unsettledTypeParameters
          )) {
            let returnIdentities = Array<ModuleTypeIdentity>();
            collectTypeIdentities(
              graph.modules,
              moduleIndex,
              signature.returnType,
              "",
              inout returnIdentities
            );
            collectGenericStructUseFromType(
              graph,
              moduleIndex,
              signature.returnType,
              returnIdentities,
              "",
              inout seen,
              inout uses
            );
          }
          if (
            signature.errorType.byteLength > 0
            && !typeContainsGenericParameter(
              signature.errorType,
              unsettledTypeParameters
            )
          ) {
            let errorIdentities = Array<ModuleTypeIdentity>();
            collectTypeIdentities(
              graph.modules,
              moduleIndex,
              signature.errorType,
              "",
              inout errorIdentities
            );
            collectGenericStructUseFromType(
              graph,
              moduleIndex,
              signature.errorType,
              errorIdentities,
              "",
              inout seen,
              inout uses
            );
          }
        }
        none => {}
      }
    }
    for (const resolution of evidence.bindingResolutions) {
      collectGenericStructUseFromType(
        graph,
        moduleIndex,
        resolution.typeName,
        resolution.typeIdentities,
        "",
        inout seen,
        inout uses
      );
    }
    for (const resolution of evidence.expressionResolutions) {
      collectGenericStructUseFromType(
        graph,
        moduleIndex,
        resolution.typeName,
        resolution.typeIdentities,
        "",
        inout seen,
        inout uses
      );
    }
    for (const resolution of evidence.callResolutions) {
      if (!typeContainsGenericParameter(
        resolution.returnType,
        unsettledTypeParameters
      )) {
        let identities = Array<ModuleTypeIdentity>();
        collectTypeIdentities(
          graph.modules,
          moduleIndex,
          resolution.returnType,
          "",
          inout identities
        );
        appendCallDeclarationTypeIdentities(
          graph,
          moduleIndex,
          resolution,
          0,
          true,
          inout identities
        );
        collectGenericStructUseFromType(
          graph,
          moduleIndex,
          resolution.returnType,
          identities,
          "",
          inout seen,
          inout uses
        );
      }
      let callParameterIndex: usize = 0;
      for (const parameterType of resolution.parameterTypes) {
        const currentParameterIndex = callParameterIndex;
        callParameterIndex = callParameterIndex + 1;
        if (typeContainsGenericParameter(
          parameterType,
          unsettledTypeParameters
        )) continue;
        let identities = Array<ModuleTypeIdentity>();
        collectTypeIdentities(
          graph.modules,
          moduleIndex,
          parameterType,
          "",
          inout identities
        );
        appendCallDeclarationTypeIdentities(
          graph,
          moduleIndex,
          resolution,
          currentParameterIndex,
          false,
          inout identities
        );
        collectGenericStructUseFromType(
          graph,
          moduleIndex,
          parameterType,
          identities,
          "",
          inout seen,
          inout uses
        );
      }
    }
    // A generic owner can reach a consumer through an imported aggregate
    // field without the consumer naming the generic class itself. Method-call
    // evidence still carries the concrete owner substitutions, so preserve
    // that transitive demand instead of requiring a redundant type import.
    for (const resolution of evidence.callResolutions) {
      if (
        resolution.kind != "method"
        && resolution.kind != "staticMethod"
      ) continue;
      if (
        resolution.targetModuleIndex >= graph.modules.length
        || resolution.targetSymbolIndex >= graph.modules[
          resolution.targetModuleIndex
        ].symbols.length
      ) continue;
      const symbol = view graph.modules[resolution.targetModuleIndex]
        .symbols[resolution.targetSymbolIndex];
      match (in symbol.typeSignature) {
        some(signature) => {
          if (
            signature.typeParameters.length == 0
            || resolution.typeArguments.length
              < resolution.callableTypeParameterCount
          ) continue;
          const ownerArgumentCount = resolution.typeArguments.length
            - resolution.callableTypeParameterCount;
          if (ownerArgumentCount != signature.typeParameters.length) {
            continue;
          }
          let ownerArguments = Array<String>();
          let identities = Array<ModuleTypeIdentity>();
          identities.push(ModuleTypeIdentity({
            path: "",
            targetModuleIndex: resolution.targetModuleIndex,
            targetSymbolIndex: resolution.targetSymbolIndex,
          }));
          let argumentIndex: usize = 0;
          while (argumentIndex < ownerArgumentCount) {
            const argument = resolution.typeArguments[argumentIndex]
              .copyBytes(
                0,
                resolution.typeArguments[argumentIndex].byteLength
              );
            const childPath = genericTypeIdentityPath(
              "",
              `${argumentIndex}`
            );
            collectTypeIdentities(
              graph.modules,
              moduleIndex,
              argument,
              childPath,
              inout identities
            );
            ownerArguments.push(move argument);
            argumentIndex = argumentIndex + 1;
          }
          const ownerType = concreteGenericTypeName(
            symbol.name,
            ownerArguments
          );
          collectGenericStructUseFromType(
            graph,
            moduleIndex,
            ownerType,
            identities,
            "",
            inout seen,
            inout uses
          );
        }
        none => {}
      }
    }
    moduleIndex = moduleIndex + 1;
  }
  return uses;
}

function sameStrings(in left: Array<String>, in right: Array<String>): boolean {
  if (left.length != right.length) return false;
  let index: usize = 0;
  while (index < left.length) {
    if (left[index] != right[index]) return false;
    index = index + 1;
  }
  return true;
}

function stringEndsWithBytes(in value: String, in suffix: String): boolean {
  if (suffix.byteLength > value.byteLength) return false;
  return value.copyBytes(
    value.byteLength - suffix.byteLength,
    value.byteLength
  ) == suffix;
}

function jsonCompilerIntrinsicKind(
  in sourcePath: String,
  in name: String
): String {
  if (
    !stringEndsWithBytes(sourcePath, "/stdlib/json.zs")
    && !stringEndsWithBytes(sourcePath, "\\stdlib\\json.zs")
  ) return "";
  if (name == "decode") return "jsonDecode";
  if (name == "encode") return "jsonEncode";
  return "";
}

function attachGenericCompilerIntrinsic(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in sourcePath: String,
  in use: LoweredGenericFunctionUse,
  inout lowered: LoweredFunction
): void throws String {
  const kind = jsonCompilerIntrinsicKind(sourcePath, use.name);
  if (kind.byteLength == 0) return;
  if (use.typeArguments.length != 1) {
    throw `native ${kind} lowering requires one concrete type argument`;
  }
  const targetType = try lowerModuleTypeName(
    program,
    importedTypes,
    use.typeArguments[0]
  );
  lowered.compilerIntrinsic = kind;
  lowered.compilerIntrinsicType = Option.some(targetType);
}

function containsGenericMethodUse(
  in uses: Array<LoweredGenericMethodUse>,
  ownerModuleIndex: usize,
  ownerSymbolIndex: usize,
  in methodName: String,
  in typeArgumentIdentities: Array<String>
): boolean {
  for (const use of uses) {
    if (
      use.ownerModuleIndex == ownerModuleIndex
      && use.ownerSymbolIndex == ownerSymbolIndex
      && use.methodName == methodName
      && sameStrings(
        use.allTypeArgumentIdentities,
        typeArgumentIdentities
      )
    ) return true;
  }
  return false;
}

function containsGenericFunctionUse(
  in uses: Array<LoweredGenericFunctionUse>,
  ownerModuleIndex: usize,
  ownerSymbolIndex: usize,
  in typeArgumentIdentities: Array<String>
): boolean {
  for (const use of uses) {
    if (
      use.ownerModuleIndex == ownerModuleIndex
      && use.ownerSymbolIndex == ownerSymbolIndex
      && sameStrings(use.typeArgumentIdentities, typeArgumentIdentities)
    ) return true;
  }
  return false;
}

function expressionContainsCallResolution(
  in expression: ExpressionSyntax,
  in resolution: ModuleCallResolution
): boolean {
  match (in expression.tree) {
    some(tree) => {
      for (const node of tree.nodes) {
        if (
          node.kind == ExpressionKind.callExpression
          && node.offset == resolution.offset
          && node.line == resolution.line
          && node.column == resolution.column
        ) return true;
      }
    }
    none => {}
  }
  return false;
}

function bodyContainsCallResolution(
  in body: StatementArena,
  in resolution: ModuleCallResolution
): boolean {
  for (const statement of body.nodes) {
    match (in statement.expression) {
      some(expression) => if (expressionContainsCallResolution(
        expression,
        resolution
      )) return true;
      none => {}
    }
    match (in statement.secondExpression) {
      some(expression) => if (expressionContainsCallResolution(
        expression,
        resolution
      )) return true;
      none => {}
    }
  }
  return false;
}

function appendGenericFunctionUse(
  in graph: ModuleGraph,
  consumerModuleIndex: usize,
  in resolution: ModuleCallResolution,
  in sourceArguments: Array<String>,
  inout uses: Array<LoweredGenericFunctionUse>
): void throws String {
  if (
    resolution.targetModuleIndex >= graph.modules.length
    || resolution.targetSymbolIndex >= graph.modules[
      resolution.targetModuleIndex
    ].symbols.length
  ) throw "native generic-function demand has an invalid target";
  const symbol = view graph.modules[resolution.targetModuleIndex]
    .symbols[resolution.targetSymbolIndex];
  match (in symbol.functionSignature) {
    some(signature) => {
      if (
        signature.typeParameters.length
          != resolution.callableTypeParameterCount
        || sourceArguments.length != resolution.callableTypeParameterCount
      ) throw `native generic-function substitutions do not match ${resolution.targetName}`;
      let arguments = Array<String>();
      let identities = Array<String>();
      let argumentModules = Array<usize>();
      let argumentSymbols = Array<usize>();
      for (const sourceArgument of sourceArguments) {
        identities.push(semanticTypeIdentity(
          graph.modules,
          consumerModuleIndex,
          sourceArgument
        ));
        match (typeSymbolLocation(
          graph.modules,
          consumerModuleIndex,
          sourceArgument
        )) {
          some(location) => {
            argumentModules.push(location.moduleIndex);
            argumentSymbols.push(location.symbolIndex);
          }
          none => {
            argumentModules.push(graph.modules.length);
            argumentSymbols.push(0);
          }
        }
        arguments.push(rebaseTypeName(
          graph.modules,
          consumerModuleIndex,
          resolution.targetModuleIndex,
          sourceArgument
        ));
      }
      if (containsGenericFunctionUse(
        uses,
        resolution.targetModuleIndex,
        resolution.targetSymbolIndex,
        identities
      )) return;
      uses.push(LoweredGenericFunctionUse({
        consumerModuleIndex,
        ownerModuleIndex: resolution.targetModuleIndex,
        ownerSymbolIndex: resolution.targetSymbolIndex,
        name: symbol.name.copyBytes(0, symbol.name.byteLength),
        typeParameters: copyStrings(signature.typeParameters),
        typeArguments: move arguments,
        typeArgumentIdentities: move identities,
        typeArgumentModules: move argumentModules,
        typeArgumentSymbols: move argumentSymbols,
      }));
    }
    none => throw "native generic-function demand has no signature";
  }
}

function collectGenericFunctionUses(
  in parsed: Array<ParsedModule>,
  in graph: ModuleGraph,
  in genericMethodUses: Array<LoweredGenericMethodUse>
): Array<LoweredGenericFunctionUse> throws String {
  let uses = Array<LoweredGenericFunctionUse>();
  let consumerModuleIndex: usize = 0;
  while (consumerModuleIndex < graph.modules.length) {
    for (const resolution of graph.modules[consumerModuleIndex]
      .semanticEvidence.callResolutions) {
      if (
        resolution.kind != "function"
        || resolution.callableTypeParameterCount == 0
      ) continue;
      if (
        resolution.targetModuleIndex >= graph.modules.length
        || resolution.targetSymbolIndex >= graph.modules[
          resolution.targetModuleIndex
        ].symbols.length
      ) throw "native generic-function demand has an invalid target";
      const symbol = view graph.modules[resolution.targetModuleIndex]
        .symbols[resolution.targetSymbolIndex];
      let unsettled = false;
      match (in symbol.functionSignature) {
        some(signature) => for (const argument of resolution.typeArguments) {
          if (typeContainsGenericParameter(
            argument,
            signature.typeParameters
          )) unsettled = true;
        }
        none => throw "native generic-function demand has no signature";
      }
      if (unsettled) continue;
      try appendGenericFunctionUse(
        graph,
        consumerModuleIndex,
        resolution,
        resolution.typeArguments,
        inout uses
      );
    }
    consumerModuleIndex = consumerModuleIndex + 1;
  }

  // A concrete generic-method specialization can itself call a generic free
  // function with the method's type parameter. Close that demand here using
  // the downstream call site's concrete substitutions.
  for (const methodUse of genericMethodUses) {
    const methodOwnerModuleIndex = methodUse.ownerModuleIndex;
    if (methodOwnerModuleIndex >= parsed.length) {
      throw "native generic-method demand lost its parsed owner";
    }
    let aggregateIndex = parsed[methodOwnerModuleIndex]
      .program.aggregates.length;
    let aggregateCandidate: usize = 0;
    while (
      aggregateCandidate < parsed[methodOwnerModuleIndex]
        .program.aggregates.length
    ) {
      if (
        parsed[methodOwnerModuleIndex].program.aggregates[
          aggregateCandidate
        ].name == methodUse.ownerName
      ) {
        aggregateIndex = aggregateCandidate;
        break;
      }
      aggregateCandidate = aggregateCandidate + 1;
    }
    if (
      aggregateIndex >= parsed[methodOwnerModuleIndex]
        .program.aggregates.length
    ) throw `native generic-method demand lost ${methodUse.ownerName}`;
    const aggregate = view parsed[methodOwnerModuleIndex]
      .program.aggregates[aggregateIndex];
    let methodIndex = aggregate.methods.length;
    let methodCandidate: usize = 0;
    while (methodCandidate < aggregate.methods.length) {
      if (aggregate.methods[methodCandidate].name == methodUse.methodName) {
        methodIndex = methodCandidate;
        break;
      }
      methodCandidate = methodCandidate + 1;
    }
    if (methodIndex >= aggregate.methods.length) {
      throw `native generic-method demand lost ${methodUse.ownerName}.${methodUse.methodName}`;
    }
    const method = view aggregate.methods[methodIndex];
    let substitutions = Array<NativeValueBinding>();
    let ownerParameter: usize = 0;
    while (
      ownerParameter < aggregate.typeParameters.length
      && ownerParameter < methodUse.ownerTypeArguments.length
    ) {
      addValueBinding(
        inout substitutions,
        aggregate.typeParameters[ownerParameter].name,
        methodUse.ownerTypeArguments[ownerParameter]
      );
      ownerParameter = ownerParameter + 1;
    }
    let methodParameter: usize = 0;
    while (
      methodParameter < method.typeParameters.length
      && methodParameter < methodUse.methodTypeArguments.length
    ) {
      addValueBinding(
        inout substitutions,
        method.typeParameters[methodParameter].name,
        methodUse.methodTypeArguments[methodParameter]
      );
      methodParameter = methodParameter + 1;
    }
    for (const resolution of graph.modules[methodOwnerModuleIndex]
      .semanticEvidence.callResolutions) {
      if (
        resolution.kind != "function"
        || resolution.callableTypeParameterCount == 0
        || !bodyContainsCallResolution(method.body, resolution)
      ) continue;
      let concreteArguments = Array<String>();
      for (const argument of resolution.typeArguments) {
        concreteArguments.push(substituteGenericType(
          argument,
          substitutions
        ));
      }
      try appendGenericFunctionUse(
        graph,
        methodUse.consumerModuleIndex,
        resolution,
        concreteArguments,
        inout uses
      );
    }
  }

  // Close the demand graph. A generic body may call another generic function
  // with its own type parameter; substitute the concrete outer demand and add
  // the resulting callee specialization. Recursion naturally deduplicates.
  let useIndex: usize = 0;
  while (useIndex < uses.length) {
    const demandConsumerModuleIndex = uses[useIndex].consumerModuleIndex;
    const ownerModuleIndex = uses[useIndex].ownerModuleIndex;
    const useName = uses[useIndex].name.copyBytes(
      0,
      uses[useIndex].name.byteLength
    );
    const useTypeParameters = copyStrings(uses[useIndex].typeParameters);
    const useTypeArguments = copyStrings(uses[useIndex].typeArguments);
    if (ownerModuleIndex >= parsed.length) {
      throw "native generic-function demand lost its parsed owner";
    }
    let declarationIndex = parsed[ownerModuleIndex].program.functions.length;
    let candidateIndex: usize = 0;
    while (
      candidateIndex < parsed[ownerModuleIndex].program.functions.length
    ) {
      if (
        parsed[ownerModuleIndex].program.functions[candidateIndex].name
          == useName
      ) {
        declarationIndex = candidateIndex;
        break;
      }
      candidateIndex = candidateIndex + 1;
    }
    if (
      declarationIndex
        >= parsed[ownerModuleIndex].program.functions.length
    ) throw `native generic-function demand lost ${useName}`;
    const declaration = view parsed[ownerModuleIndex].program.functions[
      declarationIndex
    ];
    let substitutions = Array<NativeValueBinding>();
    let parameterIndex: usize = 0;
    while (
      parameterIndex < useTypeParameters.length
      && parameterIndex < useTypeArguments.length
    ) {
      addValueBinding(
        inout substitutions,
        useTypeParameters[parameterIndex],
        useTypeArguments[parameterIndex]
      );
      parameterIndex = parameterIndex + 1;
    }
    for (const resolution of graph.modules[ownerModuleIndex]
      .semanticEvidence.callResolutions) {
      if (
        resolution.kind != "function"
        || resolution.callableTypeParameterCount == 0
        || !bodyContainsCallResolution(declaration.body, resolution)
      ) continue;
      let concreteArguments = Array<String>();
      for (const argument of resolution.typeArguments) {
        concreteArguments.push(substituteGenericType(
          argument,
          substitutions
        ));
      }
      try appendGenericFunctionUse(
        graph,
        demandConsumerModuleIndex,
        resolution,
        concreteArguments,
        inout uses
      );
    }
    useIndex = useIndex + 1;
  }
  return uses;
}

function collectGenericMethodUseForSignature(
  in graph: ModuleGraph,
  consumerModuleIndex: usize,
  in resolution: ModuleCallResolution,
  in sourceArguments: Array<String>,
  in ownerName: String,
  in signature: ModuleTypeSignature,
  inout uses: Array<LoweredGenericMethodUse>
): void throws String {
  if (
    resolution.callableTypeParameterCount > sourceArguments.length
  ) throw "native generic-method demand has incomplete substitutions";
  let methodIndex: usize = signature.methods.length;
  let candidateIndex: usize = 0;
  while (candidateIndex < signature.methods.length) {
    const target = `${ownerName}.${signature.methods[candidateIndex].name}`;
    if (resolution.targetName == target) {
      methodIndex = candidateIndex;
      break;
    }
    candidateIndex = candidateIndex + 1;
  }
  if (methodIndex >= signature.methods.length) {
    throw `native generic-method demand lost ${resolution.targetName}`;
  }
  const method = view signature.methods[methodIndex];
  const ownerCount = sourceArguments.length
    - resolution.callableTypeParameterCount;
  if (
    ownerCount != signature.typeParameters.length
    || method.signature.typeParameters.length
      != resolution.callableTypeParameterCount
  ) throw `native generic-method substitutions do not match ${resolution.targetName}`;
  let ownerArguments = Array<String>();
  let methodArguments = Array<String>();
  let allArguments = Array<String>();
  let allArgumentIdentities = Array<String>();
  let argumentModules = Array<usize>();
  let argumentSymbols = Array<usize>();
  let argumentIndex: usize = 0;
  while (argumentIndex < sourceArguments.length) {
    const sourceArgument = sourceArguments[argumentIndex]
      .copyBytes(0, sourceArguments[argumentIndex].byteLength);
    allArgumentIdentities.push(semanticTypeIdentity(
      graph.modules,
      consumerModuleIndex,
      sourceArgument
    ));
    match (typeSymbolLocation(
      graph.modules,
      consumerModuleIndex,
      sourceArgument
    )) {
      some(location) => {
        argumentModules.push(location.moduleIndex);
        argumentSymbols.push(location.symbolIndex);
      }
      none => {
        argumentModules.push(graph.modules.length);
        argumentSymbols.push(0);
      }
    }
    const argument = rebaseTypeName(
      graph.modules,
      consumerModuleIndex,
      resolution.targetModuleIndex,
      sourceArgument
    );
    allArguments.push(argument.copyBytes(0, argument.byteLength));
    if (argumentIndex < ownerCount) {
      ownerArguments.push(move argument);
    } else methodArguments.push(move argument);
    argumentIndex = argumentIndex + 1;
  }
  if (containsGenericMethodUse(
    uses,
    resolution.targetModuleIndex,
    resolution.targetSymbolIndex,
    method.name,
    allArgumentIdentities
  )) return;
  uses.push(LoweredGenericMethodUse({
    consumerModuleIndex,
    ownerModuleIndex: resolution.targetModuleIndex,
    ownerSymbolIndex: resolution.targetSymbolIndex,
    ownerName: ownerName.copyBytes(0, ownerName.byteLength),
    methodName: method.name.copyBytes(0, method.name.byteLength),
    ownerTypeArguments: move ownerArguments,
    methodTypeParameters: copyStrings(method.signature.typeParameters),
    methodTypeArguments: move methodArguments,
    allTypeArguments: move allArguments,
    allTypeArgumentIdentities: move allArgumentIdentities,
    typeArgumentModules: move argumentModules,
    typeArgumentSymbols: move argumentSymbols,
  }));
}

function appendGenericMethodUseForResolution(
  in graph: ModuleGraph,
  consumerModuleIndex: usize,
  in resolution: ModuleCallResolution,
  in sourceArguments: Array<String>,
  inout uses: Array<LoweredGenericMethodUse>
): void throws String {
  if (
    resolution.targetModuleIndex >= graph.modules.length
    || resolution.targetSymbolIndex >= graph.modules[
      resolution.targetModuleIndex
    ].symbols.length
  ) throw "native generic-method demand has an invalid owner";
  const symbol = view graph.modules[resolution.targetModuleIndex]
    .symbols[resolution.targetSymbolIndex];
  match (in symbol.typeSignature) {
    some(signature) => try collectGenericMethodUseForSignature(
      graph,
      consumerModuleIndex,
      resolution,
      sourceArguments,
      symbol.name,
      signature,
      inout uses
    );
    none => throw "native generic-method demand has no owner signature";
  }
}

function resolutionHasUnsettledTypeArguments(
  in module: ParsedModule,
  in resolution: ModuleCallResolution
): boolean {
  let parameters = Array<String>();
  for (const declaration of module.program.functions) {
    if (!bodyContainsCallResolution(declaration.body, resolution)) continue;
    for (const parameter of declaration.typeParameters) {
      parameters.push(parameter.name.copyBytes(0, parameter.name.byteLength));
    }
  }
  for (const aggregate of module.program.aggregates) {
    for (const method of aggregate.methods) {
      if (!bodyContainsCallResolution(method.body, resolution)) continue;
      for (const parameter of aggregate.typeParameters) {
        parameters.push(parameter.name.copyBytes(0, parameter.name.byteLength));
      }
      for (const parameter of method.typeParameters) {
        parameters.push(parameter.name.copyBytes(0, parameter.name.byteLength));
      }
    }
  }
  for (const argument of resolution.typeArguments) {
    if (typeContainsGenericParameter(argument, parameters)) return true;
  }
  return false;
}

function collectGenericMethodUses(
  in parsed: Array<ParsedModule>,
  in graph: ModuleGraph
): Array<LoweredGenericMethodUse> throws String {
  let uses = Array<LoweredGenericMethodUse>();
  let consumerModuleIndex: usize = 0;
  while (consumerModuleIndex < graph.modules.length) {
    for (const resolution of graph.modules[consumerModuleIndex]
      .semanticEvidence.callResolutions) {
      if (
        resolution.callableTypeParameterCount == 0
        || (
          resolution.kind != "method"
          && resolution.kind != "staticMethod"
        )
      ) continue;
      if (resolutionHasUnsettledTypeArguments(
        parsed[consumerModuleIndex],
        resolution
      )) continue;
      try appendGenericMethodUseForResolution(
        graph,
        consumerModuleIndex,
        resolution,
        resolution.typeArguments,
        inout uses
      );
    }
    consumerModuleIndex = consumerModuleIndex + 1;
  }
  return uses;
}

function closeGenericMethodDemandGraph(
  in parsed: Array<ParsedModule>,
  in graph: ModuleGraph,
  in functionUses: Array<LoweredGenericFunctionUse>,
  inout methodUses: Array<LoweredGenericMethodUse>
): void throws String {
  for (const functionUse of functionUses) {
    const ownerModuleIndex = functionUse.ownerModuleIndex;
    if (ownerModuleIndex >= parsed.length) {
      throw "native generic-function demand lost its parsed owner";
    }
    let declarationIndex = parsed[ownerModuleIndex].program.functions.length;
    let candidateIndex: usize = 0;
    while (candidateIndex < parsed[ownerModuleIndex].program.functions.length) {
      if (
        parsed[ownerModuleIndex].program.functions[candidateIndex].name
          == functionUse.name
      ) {
        declarationIndex = candidateIndex;
        break;
      }
      candidateIndex = candidateIndex + 1;
    }
    if (declarationIndex >= parsed[ownerModuleIndex].program.functions.length) {
      throw `native generic-function demand lost ${functionUse.name}`;
    }
    const declaration = view parsed[ownerModuleIndex].program.functions[
      declarationIndex
    ];
    let substitutions = Array<NativeValueBinding>();
    let parameterIndex: usize = 0;
    while (
      parameterIndex < functionUse.typeParameters.length
      && parameterIndex < functionUse.typeArguments.length
    ) {
      addValueBinding(
        inout substitutions,
        functionUse.typeParameters[parameterIndex],
        functionUse.typeArguments[parameterIndex]
      );
      parameterIndex = parameterIndex + 1;
    }
    for (const resolution of graph.modules[ownerModuleIndex]
      .semanticEvidence.callResolutions) {
      if (
        resolution.callableTypeParameterCount == 0
        || (
          resolution.kind != "method"
          && resolution.kind != "staticMethod"
        )
        || !bodyContainsCallResolution(declaration.body, resolution)
      ) continue;
      let concreteArguments = Array<String>();
      for (const argument of resolution.typeArguments) {
        concreteArguments.push(substituteGenericType(
          argument,
          substitutions
        ));
      }
      try appendGenericMethodUseForResolution(
        graph,
        functionUse.consumerModuleIndex,
        resolution,
        concreteArguments,
        inout methodUses
      );
    }
  }

  let methodUseIndex: usize = 0;
  while (methodUseIndex < methodUses.length) {
    const methodConsumerModuleIndex = methodUses[methodUseIndex]
      .consumerModuleIndex;
    const ownerModuleIndex = methodUses[methodUseIndex].ownerModuleIndex;
    const methodOwnerName = methodUses[methodUseIndex].ownerName.copyBytes(
      0,
      methodUses[methodUseIndex].ownerName.byteLength
    );
    const methodName = methodUses[methodUseIndex].methodName.copyBytes(
      0,
      methodUses[methodUseIndex].methodName.byteLength
    );
    const ownerTypeArguments = copyStrings(
      methodUses[methodUseIndex].ownerTypeArguments
    );
    const methodTypeArguments = copyStrings(
      methodUses[methodUseIndex].methodTypeArguments
    );
    if (ownerModuleIndex >= parsed.length) {
      throw "native generic-method demand lost its parsed owner";
    }
    let aggregateIndex = parsed[ownerModuleIndex].program.aggregates.length;
    let aggregateCandidate: usize = 0;
    while (aggregateCandidate < parsed[ownerModuleIndex].program.aggregates.length) {
      if (
        parsed[ownerModuleIndex].program.aggregates[aggregateCandidate].name
          == methodOwnerName
      ) {
        aggregateIndex = aggregateCandidate;
        break;
      }
      aggregateCandidate = aggregateCandidate + 1;
    }
    if (aggregateIndex >= parsed[ownerModuleIndex].program.aggregates.length) {
      throw `native generic-method demand lost ${methodOwnerName}`;
    }
    const aggregate = view parsed[ownerModuleIndex].program.aggregates[
      aggregateIndex
    ];
    let methodIndex = aggregate.methods.length;
    let methodCandidate: usize = 0;
    while (methodCandidate < aggregate.methods.length) {
      if (aggregate.methods[methodCandidate].name == methodName) {
        methodIndex = methodCandidate;
        break;
      }
      methodCandidate = methodCandidate + 1;
    }
    if (methodIndex >= aggregate.methods.length) {
      throw `native generic-method demand lost ${methodOwnerName}.${methodName}`;
    }
    const method = view aggregate.methods[methodIndex];
    let substitutions = Array<NativeValueBinding>();
    let ownerParameter: usize = 0;
    while (
      ownerParameter < aggregate.typeParameters.length
      && ownerParameter < ownerTypeArguments.length
    ) {
      addValueBinding(
        inout substitutions,
        aggregate.typeParameters[ownerParameter].name,
        ownerTypeArguments[ownerParameter]
      );
      ownerParameter = ownerParameter + 1;
    }
    let methodParameter: usize = 0;
    while (
      methodParameter < method.typeParameters.length
      && methodParameter < methodTypeArguments.length
    ) {
      addValueBinding(
        inout substitutions,
        method.typeParameters[methodParameter].name,
        methodTypeArguments[methodParameter]
      );
      methodParameter = methodParameter + 1;
    }
    for (const resolution of graph.modules[ownerModuleIndex]
      .semanticEvidence.callResolutions) {
      if (
        resolution.callableTypeParameterCount == 0
        || (
          resolution.kind != "method"
          && resolution.kind != "staticMethod"
        )
        || !bodyContainsCallResolution(method.body, resolution)
      ) continue;
      let concreteArguments = Array<String>();
      for (const argument of resolution.typeArguments) {
        concreteArguments.push(substituteGenericType(
          argument,
          substitutions
        ));
      }
      try appendGenericMethodUseForResolution(
        graph,
        methodConsumerModuleIndex,
        resolution,
        concreteArguments,
        inout methodUses
      );
    }
    methodUseIndex = methodUseIndex + 1;
  }
}

function localFunctionTypeIdentity(
  in program: Program,
  in signature: ModuleFunctionSignature
): String throws String {
  let canonical = TextBuffer();
  if (signature.asynchronous) canonical.append("async ");
  let parameter: usize = 0;
  while (parameter < signature.parameterTypes.length) {
    canonical.append(signature.parameterModes[parameter]);
    canonical.append(":");
    const type = try lowerTypeName(
      program,
      signature.parameterTypes[parameter]
    );
    canonical.append(loweredTypeIdentity(type));
    canonical.append(";");
    parameter = parameter + 1;
  }
  canonical.append("=>");
  const returnType = try lowerTypeName(program, signature.returnType);
  canonical.append(loweredTypeIdentity(returnType));
  canonical.append(" throws ");
  if (signature.errorType.byteLength > 0) {
    const errorType = try lowerTypeName(program, signature.errorType);
    canonical.append(loweredTypeIdentity(errorType));
  }
  const identity = canonical.finish();
  return encodedFunctionTypeIdentity(identity);
}

function moduleFunctionTypeIdentity(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in signature: ModuleFunctionSignature
): String throws String {
  let canonical = TextBuffer();
  if (signature.asynchronous) canonical.append("async ");
  let parameter: usize = 0;
  while (parameter < signature.parameterTypes.length) {
    canonical.append(signature.parameterModes[parameter]);
    canonical.append(":");
    const type = try lowerModuleTypeName(
      program,
      importedTypes,
      signature.parameterTypes[parameter]
    );
    canonical.append(loweredTypeIdentity(type));
    canonical.append(";");
    parameter = parameter + 1;
  }
  canonical.append("=>");
  const returnType = try lowerModuleTypeName(
    program,
    importedTypes,
    signature.returnType
  );
  canonical.append(loweredTypeIdentity(returnType));
  canonical.append(" throws ");
  if (signature.errorType.byteLength > 0) {
    const errorType = try lowerModuleTypeName(
      program,
      importedTypes,
      signature.errorType
    );
    canonical.append(loweredTypeIdentity(errorType));
  }
  const identity = canonical.finish();
  return encodedFunctionTypeIdentity(identity);
}

function moduleCallFunctionTypeIdentity(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in resolution: ModuleCallResolution
): String throws String {
  if (resolution.parameterModes.length != resolution.parameterTypes.length) {
    throw "native async call evidence has mismatched parameter capabilities";
  }
  let canonical = TextBuffer();
  if (resolution.asynchronous) canonical.append("async ");
  let parameter: usize = 0;
  while (parameter < resolution.parameterTypes.length) {
    canonical.append(resolution.parameterModes[parameter]);
    canonical.append(":");
    const type = try lowerModuleTypeName(
      program,
      importedTypes,
      resolution.parameterTypes[parameter]
    );
    canonical.append(loweredTypeIdentity(type));
    canonical.append(";");
    parameter = parameter + 1;
  }
  canonical.append("=>");
  const returnType = try lowerModuleTypeName(
    program,
    importedTypes,
    resolution.returnType
  );
  canonical.append(loweredTypeIdentity(returnType));
  canonical.append(" throws ");
  if (resolution.errorType.byteLength > 0) {
    const errorType = try lowerModuleTypeName(
      program,
      importedTypes,
      resolution.errorType
    );
    canonical.append(loweredTypeIdentity(errorType));
  }
  const identity = canonical.finish();
  return encodedFunctionTypeIdentity(identity);
}

function localTypeAliasTarget(
  in program: Program,
  in name: String
): Option<String> {
  for (const declaration of program.typeAliases) {
    if (declaration.name == name) {
      return Option.some(declaration.target.name.copyBytes(
        0,
        declaration.target.name.byteLength
      ));
    }
  }
  return Option<String>.none;
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
  if (type.kind == LoweredTypeKind.arenaType) return "Arena";
  if (type.kind == LoweredTypeKind.hasherType) return "Hasher";
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

function intrinsicViewOptionName(in payload: LoweredType): String {
  const identity = loweredTypeIdentity(payload);
  return `__z_NicheViewOption_${identity}`;
}

function intrinsicArrayName(in elementType: LoweredType): String {
  const identity = loweredTypeIdentity(elementType);
  return `__z_Array_${identity}`;
}

function intrinsicFixedArrayName(
  in elementType: LoweredType,
  in length: String
): String {
  const identity = loweredTypeIdentity(elementType);
  return `__z_FixedArray_${length}_${identity}`;
}

function intrinsicFixedArrayElementIdentity(in name: String): Option<String> {
  const prefix = "__z_FixedArray_";
  if (
    !stringStartsWith(name, prefix)
    || name.byteLength <= prefix.byteLength + 2
  ) return Option<String>.none;
  let index = prefix.byteLength;
  let sawDigit = false;
  while (index < name.byteLength && name.byteAt(index) != 95) {
    const byte = name.byteAt(index);
    if (byte < 48 || byte > 57) return Option<String>.none;
    sawDigit = true;
    index = index + 1;
  }
  if (!sawDigit || index + 1 >= name.byteLength) {
    return Option<String>.none;
  }
  return Option.some(name.copyBytes(index + 1, name.byteLength));
}

function intrinsicSliceName(in elementType: LoweredType): String {
  const identity = loweredTypeIdentity(elementType);
  return `__z_Slice_${identity}`;
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

function intrinsicWeakName(in targetType: LoweredType): String {
  const identity = loweredTypeIdentity(targetType);
  return `${identity}_weak`;
}

function intrinsicTaskName(in resultType: LoweredType): String {
  const identity = loweredTypeIdentity(resultType);
  return `Task_${identity}`;
}

function importedArenaBinding(in program: Program, in name: String): boolean {
  if (name == "Arena") return true;
  for (const declaration of program.imports) {
    if (declaration.header != "std/memory" || !declaration.selective) {
      continue;
    }
    for (const binding of declaration.bindings) {
      if (
        binding.localName == name
        && binding.importedName == "Arena"
      ) return true;
    }
  }
  return false;
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

function intrinsicViewOptionPayloadName(in name: String): Option<String> {
  const prefix = "__z_NicheViewOption_";
  if (!stringStartsWith(name, prefix)) return Option<String>.none;
  return Option.some(name.copyBytes(prefix.byteLength, name.byteLength));
}

function optionPayloadTypeName(in name: String): Option<String> {
  match (genericTypeShape(name)) {
    some(generic) => {
      if (generic.base == "Option" && generic.arguments.length == 1) {
        return Option.some(generic.arguments[0].copyBytes(
          0,
          generic.arguments[0].byteLength
        ));
      }
    }
    none => {}
  }
  match (intrinsicViewOptionPayloadName(name)) {
    some(payload) => return Option.some(`view ${payload}`);
    none => {}
  }
  return intrinsicOptionPayloadName(name);
}

function sourceTypeIsOption(in name: String): boolean {
  match (genericTypeShape(name)) {
    some(generic) => return generic.base == "Option"
      && generic.arguments.length == 1;
    none => return stringStartsWith(name, "__z_Option_")
      || stringStartsWith(name, "__z_NicheViewOption_");
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
  match (localTypeAliasTarget(program, name)) {
    some(target) => return try lowerTypeName(program, target);
    none => {}
  }
  match (nativeFunctionSignature(name)) {
    some(signature) => {
      const identity = try localFunctionTypeIdentity(program, signature);
      return LoweredType({
        kind: LoweredTypeKind.functionType,
        name: identity,
      });
    }
    none => {}
  }
  if (stringStartsWith(name, "Function_")) {
    return LoweredType({
      kind: LoweredTypeKind.functionType,
      name: name.copyBytes(0, name.byteLength),
    });
  }
  if (stringStartsWith(name, "Mutex_")) {
    return LoweredType({
      kind: LoweredTypeKind.mutexType,
      name: name.copyBytes(0, name.byteLength),
    });
  }
  if (stringStartsWith(name, "Task_")) {
    return LoweredType({
      kind: LoweredTypeKind.taskType,
      name: name.copyBytes(0, name.byteLength),
    });
  }
  if (name == "TaskScope") {
    return LoweredType({
      kind: LoweredTypeKind.taskScopeType,
      name: "TaskScope",
    });
  }
  if (name == "TaskControl") {
    return LoweredType({
      kind: LoweredTypeKind.taskControlType,
      name: "TaskControl",
    });
  }
  if (stringStartsWith(name, "OnceLifetime_")) {
    return LoweredType({
      kind: LoweredTypeKind.onceLifetimeType,
      name: name.copyBytes(0, name.byteLength),
    });
  }
  if (stringStartsWith(name, "Once_")) {
    return LoweredType({
      kind: LoweredTypeKind.onceType,
      name: name.copyBytes(0, name.byteLength),
    });
  }
  if (name == "OnceState") {
    return LoweredType({
      kind: LoweredTypeKind.enumType,
      name: "OnceState",
    });
  }
  if (name == "objc.Registration" || name == "ZObjCRegistration") {
    return LoweredType({
      kind: LoweredTypeKind.foreignObjCType,
      name: "ZObjCRegistration",
    });
  }
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
  if (importedArenaBinding(program, name)) {
    return LoweredType({
      kind: LoweredTypeKind.arenaType,
      name: "Arena",
    });
  }
  if (name == "Hasher") {
    return LoweredType({
      kind: LoweredTypeKind.hasherType,
      name: "Hasher",
    });
  }
  if (name == "String" || name == "TextBuffer") {
    return LoweredType({
      kind: LoweredTypeKind.stringType,
      name: "String",
    });
  }
  if (name == "embed.StaticBytes" || name == "StaticBytes") {
    return LoweredType({
      kind: LoweredTypeKind.staticBytesType,
      name: "StaticBytes",
    });
  }
  if (name == "cstring") {
    return LoweredType({
      kind: LoweredTypeKind.cstringType,
      name: "cstring",
    });
  }
  if (name == "null") {
    // A `.zd` null-only parameter is source-visible so callers must spell the
    // sentinel explicitly, but it has no independent runtime value type.
    // Lower it as the universal C pointer carrier; the expression itself emits
    // NULL and the imported ABI signature remains authoritative.
    return LoweredType({
      kind: LoweredTypeKind.foreignHandleType,
      name: "void *",
    });
  }
  if (name == "WeakExpired") {
    return LoweredType({
      kind: LoweredTypeKind.structType,
      name: "WeakExpired",
    });
  }
  match (fixedArrayShape(name)) {
    some(shape) => {
      const elementType = try lowerTypeName(program, shape.elementType);
      return LoweredType({
        kind: LoweredTypeKind.fixedArrayType,
        name: intrinsicFixedArrayName(elementType, shape.length),
      });
    }
    none => {}
  }
  match (intrinsicFixedArrayElementIdentity(name)) {
    some(_) => return LoweredType({
      kind: LoweredTypeKind.fixedArrayType,
      name: name.copyBytes(0, name.byteLength),
    });
    none => {}
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
  match (intrinsicViewOptionPayloadName(name)) {
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
          name: stringStartsWith(generic.arguments[0], "view ")
            ? intrinsicViewOptionName(payload)
            : intrinsicOptionName(payload),
        });
      }
      if (generic.base == "Weak" && generic.arguments.length == 1) {
        const targetType = try lowerTypeName(program, generic.arguments[0]);
        if (targetType.kind != LoweredTypeKind.classType) {
          throw `native Weak<T> lowering expected a class, found ${generic.arguments[0]}`;
        }
        return LoweredType({
          kind: LoweredTypeKind.weakType,
          name: intrinsicWeakName(targetType),
        });
      }
      if (generic.base == "Array" && generic.arguments.length == 1) {
        const elementType = try lowerTypeName(program, generic.arguments[0]);
        return LoweredType({
          kind: LoweredTypeKind.arrayType,
          name: intrinsicArrayName(elementType),
        });
      }
      if (generic.base == "Slice" && generic.arguments.length == 1) {
        const elementType = try lowerTypeName(program, generic.arguments[0]);
        return LoweredType({
          kind: LoweredTypeKind.sliceType,
          name: intrinsicSliceName(elementType),
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
      if (generic.base == "Map.Entry" && generic.arguments.length == 2) {
        const keyType = try lowerTypeName(program, generic.arguments[0]);
        const valueType = try lowerTypeName(program, generic.arguments[1]);
        const mapName = intrinsicMapName(keyType, valueType);
        return LoweredType({
          kind: LoweredTypeKind.structType,
          name: `${mapName}_Entry`,
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
  if (name == "embed.StaticBytes" || name == "StaticBytes") {
    return LoweredType({
      kind: LoweredTypeKind.staticBytesType,
      name: "StaticBytes",
    });
  }
  if (name == "id") return LoweredType({
    kind: LoweredTypeKind.foreignObjCType,
    name: "id",
  });
  if (qualifiedTypeMember(name) == "NSData") return LoweredType({
    kind: LoweredTypeKind.foreignObjCType,
    name: "NSData",
  });
  if (name == "objc.Selector") return LoweredType({
    kind: LoweredTypeKind.foreignHandleType,
    name: "SEL",
  });
  match (localTypeAliasTarget(program, name)) {
    some(target) => return try lowerModuleTypeName(
      program,
      importedTypes,
      target
    );
    none => {}
  }
  match (nativeFunctionSignature(name)) {
    some(signature) => {
      const identity = try moduleFunctionTypeIdentity(
        program,
        importedTypes,
        signature
      );
      return LoweredType({
        kind: LoweredTypeKind.functionType,
        name: identity,
      });
    }
    none => {}
  }
  if (stringStartsWith(name, "Function_")) {
    return LoweredType({
      kind: LoweredTypeKind.functionType,
      name: name.copyBytes(0, name.byteLength),
    });
  }
  if (stringStartsWith(name, "Mutex_")) {
    return LoweredType({
      kind: LoweredTypeKind.mutexType,
      name: name.copyBytes(0, name.byteLength),
    });
  }
  if (stringStartsWith(name, "Task_")) {
    return LoweredType({
      kind: LoweredTypeKind.taskType,
      name: name.copyBytes(0, name.byteLength),
    });
  }
  if (name == "TaskScope") {
    return LoweredType({
      kind: LoweredTypeKind.taskScopeType,
      name: "TaskScope",
    });
  }
  if (name == "TaskControl") {
    return LoweredType({
      kind: LoweredTypeKind.taskControlType,
      name: "TaskControl",
    });
  }
  if (stringStartsWith(name, "OnceLifetime_")) {
    return LoweredType({
      kind: LoweredTypeKind.onceLifetimeType,
      name: name.copyBytes(0, name.byteLength),
    });
  }
  if (stringStartsWith(name, "Once_")) {
    return LoweredType({
      kind: LoweredTypeKind.onceType,
      name: name.copyBytes(0, name.byteLength),
    });
  }
  if (name == "OnceState") {
    return LoweredType({
      kind: LoweredTypeKind.enumType,
      name: "OnceState",
    });
  }
  if (name == "objc.Registration" || name == "ZObjCRegistration") {
    return LoweredType({
      kind: LoweredTypeKind.foreignObjCType,
      name: "ZObjCRegistration",
    });
  }
  const nullableTarget = nullableTargetType(name);
  if (nullableTarget.byteLength > 0) {
    return try lowerModuleTypeName(program, importedTypes, nullableTarget);
  }
  if (stringStartsWith(name, "view ")) {
    const targetName = name.copyBytes(5, name.byteLength);
    return try lowerModuleTypeName(
      program,
      importedTypes,
      targetName
    );
  }
  if (stringStartsWith(name, "readonly ")) {
    const targetName = name.copyBytes(9, name.byteLength);
    return try lowerModuleTypeName(
      program,
      importedTypes,
      targetName
    );
  }
  if (name == "WeakExpired") {
    return LoweredType({
      kind: LoweredTypeKind.structType,
      name: "WeakExpired",
    });
  }
  match (fixedArrayShape(name)) {
    some(shape) => {
      const elementType = try lowerModuleTypeName(
        program,
        importedTypes,
        shape.elementType
      );
      return LoweredType({
        kind: LoweredTypeKind.fixedArrayType,
        name: intrinsicFixedArrayName(elementType, shape.length),
      });
    }
    none => {}
  }
  match (intrinsicFixedArrayElementIdentity(name)) {
    some(_) => return LoweredType({
      kind: LoweredTypeKind.fixedArrayType,
      name: name.copyBytes(0, name.byteLength),
    });
    none => {}
  }
  match (intrinsicViewOptionPayloadName(name)) {
    some(_) => return LoweredType({
      kind: LoweredTypeKind.enumType,
      name: name.copyBytes(0, name.byteLength),
    });
    none => {}
  }
  match (genericTypeShape(name)) {
    some(generic) => {
      if (
        qualifiedTypeMember(generic.base) == "Adapter"
        && generic.arguments.length == 1
      ) {
        const protocol = try lowerModuleTypeName(
          program,
          importedTypes,
          generic.arguments[0]
        );
        if (protocol.kind != LoweredTypeKind.foreignObjCType) {
          throw `native objc.Adapter<P> lowering expected an imported Objective-C protocol, found ${generic.arguments[0]}`;
        }
        return LoweredType({
          kind: LoweredTypeKind.foreignObjCType,
          name: stringStartsWith(protocol.name, "id<")
            ? protocol.name.copyBytes(0, protocol.name.byteLength)
            : `id<${protocol.name}>`,
        });
      }
      if (generic.base == "Option" && generic.arguments.length == 1) {
        const payload = try lowerModuleTypeName(
          program,
          importedTypes,
          generic.arguments[0]
        );
        return LoweredType({
          kind: LoweredTypeKind.enumType,
          name: stringStartsWith(generic.arguments[0], "view ")
            ? intrinsicViewOptionName(payload)
            : intrinsicOptionName(payload),
        });
      }
      if (generic.base == "Weak" && generic.arguments.length == 1) {
        const targetType = try lowerModuleTypeName(
          program,
          importedTypes,
          generic.arguments[0]
        );
        if (targetType.kind != LoweredTypeKind.classType) {
          throw `native Weak<T> lowering expected a class, found ${generic.arguments[0]}`;
        }
        return LoweredType({
          kind: LoweredTypeKind.weakType,
          name: intrinsicWeakName(targetType),
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
      if (generic.base == "Slice" && generic.arguments.length == 1) {
        const elementType = try lowerModuleTypeName(
          program,
          importedTypes,
          generic.arguments[0]
        );
        return LoweredType({
          kind: LoweredTypeKind.sliceType,
          name: intrinsicSliceName(elementType),
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
      if (generic.base == "Map.Entry" && generic.arguments.length == 2) {
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
        const mapName = intrinsicMapName(keyType, valueType);
        return LoweredType({
          kind: LoweredTypeKind.structType,
          name: `${mapName}_Entry`,
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
      // Prefer an exact concrete source spelling before compatibility
      // matching. Specialization aliases such as `T -> i32` can make the
      // unspecialized `Box<T>` template appear compatible with `Box<i32>`;
      // selecting that template loses the concrete emitted ABI identity.
      let exactIndex = importedTypes.length;
      while (exactIndex > 0) {
        exactIndex = exactIndex - 1;
        if (importedTypes[exactIndex].localName == name) {
          return LoweredType({
            kind: importedTypes[exactIndex].kind,
            name: importedTypes[exactIndex].targetName.copyBytes(
              0,
              importedTypes[exactIndex].targetName.byteLength
            ),
          });
        }
      }
      // A specialized generic function still carries its source spelling
      // (for example Pair<T>) in the parsed declaration. Match that shape
      // against the concrete generic aliases already materialized for this
      // module after resolving T through the specialization aliases.
      let candidateIndex = importedTypes.length;
      while (candidateIndex > 0) {
        candidateIndex = candidateIndex - 1;
        match (genericTypeShape(importedTypes[candidateIndex].localName)) {
          some(candidate) => {
            if (
              candidate.base != generic.base
              || candidate.arguments.length != generic.arguments.length
            ) continue;
            let matches = true;
            let argumentIndex: usize = 0;
            while (argumentIndex < generic.arguments.length) {
              const expected = try lowerModuleTypeName(
                program,
                importedTypes,
                generic.arguments[argumentIndex]
              );
              const actual = try lowerModuleTypeName(
                program,
                importedTypes,
                candidate.arguments[argumentIndex]
              );
              if (loweredTypeIdentity(expected) != loweredTypeIdentity(actual)) {
                matches = false;
                break;
              }
              argumentIndex = argumentIndex + 1;
            }
            if (matches) return LoweredType({
              kind: importedTypes[candidateIndex].kind,
              name: importedTypes[candidateIndex].targetName.copyBytes(
                0,
                importedTypes[candidateIndex].targetName.byteLength
              ),
            });
          }
          none => {}
        }
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
  const qualifiedMember = qualifiedTypeMember(name);
  if (qualifiedMember.byteLength > 0) {
    importedIndex = importedTypes.length;
    while (importedIndex > 0) {
      importedIndex = importedIndex - 1;
      if (
        importedTypes[importedIndex].localName == qualifiedMember
        || importedTypes[importedIndex].targetName == qualifiedMember
      ) return LoweredType({
        kind: importedTypes[importedIndex].kind,
        name: importedTypes[importedIndex].targetName.copyBytes(
          0,
          importedTypes[importedIndex].targetName.byteLength
        ),
      });
    }
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
    || type.kind == LoweredTypeKind.weakType
    || type.kind == LoweredTypeKind.onceLifetimeType
    || type.kind == LoweredTypeKind.mutexType
    || type.kind == LoweredTypeKind.taskType
    || type.kind == LoweredTypeKind.taskScopeType
    || type.kind == LoweredTypeKind.taskControlType
    || type.kind == LoweredTypeKind.arenaType
    || type.kind == LoweredTypeKind.functionType
  ) return true;
  if (type.kind == LoweredTypeKind.fixedArrayType) {
    match (intrinsicFixedArrayElementIdentity(type.name)) {
      some(elementName) => {
        const element = attempt lowerTypeName(program, elementName);
        return match (element) {
          success(lowered) => typeNeedsCleanup(program, lowered);
          failure(_) => false;
        };
      }
      none => return false;
    }
  }
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
    || type.kind == LoweredTypeKind.weakType
    || type.kind == LoweredTypeKind.onceLifetimeType
    || type.kind == LoweredTypeKind.mutexType
    || type.kind == LoweredTypeKind.taskType
    || type.kind == LoweredTypeKind.taskScopeType
    || type.kind == LoweredTypeKind.taskControlType
    || type.kind == LoweredTypeKind.arenaType
    || type.kind == LoweredTypeKind.functionType
  ) return true;
  if (type.kind == LoweredTypeKind.fixedArrayType) {
    match (intrinsicFixedArrayElementIdentity(type.name)) {
      some(elementName) => {
        const element = attempt lowerModuleTypeName(
          program,
          importedTypes,
          elementName
        );
        return match (element) {
          success(lowered) => moduleTypeNeedsCleanupDepth(
            program,
            importedTypes,
            lowered,
            depth + 1
          );
          failure(_) => false;
        };
      }
      none => return false;
    }
  }
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
    match (intrinsicOptionPayloadName(type.name)) {
      some(payloadName) => {
        const payload = attempt lowerModuleTypeName(
          program,
          importedTypes,
          payloadName
        );
        return match (payload) {
          success(lowered) => moduleTypeNeedsCleanupDepth(
            program,
            importedTypes,
            lowered,
            depth + 1
          );
          failure(_) => false;
        };
      }
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

function loweredTypeSupportsCopyHelper(in type: LoweredType): boolean {
  return type.kind == LoweredTypeKind.stringType
    || type.kind == LoweredTypeKind.arrayType
    || type.kind == LoweredTypeKind.fixedArrayType
    || type.kind == LoweredTypeKind.structType
    || type.kind == LoweredTypeKind.enumType;
}

function moduleTypeRetainsCapturedIdentity(in type: LoweredType): boolean {
  return type.kind == LoweredTypeKind.classType
    || type.kind == LoweredTypeKind.weakType
    || type.kind == LoweredTypeKind.mutexType
    || type.kind == LoweredTypeKind.taskScopeType
    || type.kind == LoweredTypeKind.taskControlType
    || type.kind == LoweredTypeKind.functionType;
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

function moduleTypeHasExecutorAffinity(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in name: String,
  in visiting: Array<String>
): boolean {
  match (genericTypeShape(name)) {
    some(generic) => {
      if (
        qualifiedTypeMember(generic.base) == "Adapter"
        && generic.arguments.length == 1
      ) return true;
      if (
        (
          generic.base == "Option"
          || generic.base == "Array"
          || generic.base == "Set"
        )
        && generic.arguments.length == 1
      ) return moduleTypeHasExecutorAffinity(
        program,
        importedTypes,
        generic.arguments[0],
        visiting
      );
      if (
        (
          generic.base == "Map"
          || generic.base == "Result"
        )
        && generic.arguments.length == 2
      ) {
        for (const argument of generic.arguments) {
          if (moduleTypeHasExecutorAffinity(
            program,
            importedTypes,
            argument,
            visiting
          )) return true;
        }
      }
      return false;
    }
    none => {}
  }
  if (containsString(visiting, name)) return false;
  for (const declaration of program.aggregates) {
    if (declaration.name != name) continue;
    if (declaration.executorAffinity.byteLength > 0) return true;
    let nextVisiting = copyTypePath(visiting);
    nextVisiting.push(name.copyBytes(0, name.byteLength));
    for (const field of declaration.fields) {
      if (
        field.executorAffinity.byteLength > 0
        || moduleTypeHasExecutorAffinity(
          program,
          importedTypes,
          field.type.name,
          nextVisiting
        )
      ) return true;
    }
    return false;
  }
  for (const declaration of program.enums) {
    if (declaration.name != name) continue;
    let nextVisiting = copyTypePath(visiting);
    nextVisiting.push(name.copyBytes(0, name.byteLength));
    for (const variant of declaration.variants) {
      match (in variant.payload) {
        some(payload) => {
          if (moduleTypeHasExecutorAffinity(
            program,
            importedTypes,
            payload.name,
            nextVisiting
          )) return true;
        }
        none => {}
      }
    }
    return false;
  }
  let importedIndex = importedTypes.length;
  while (importedIndex > 0) {
    importedIndex = importedIndex - 1;
    if (
      importedTypes[importedIndex].localName == name
      || importedTypes[importedIndex].targetName == name
    ) return importedTypes[importedIndex].executorBound;
  }
  return false;
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
  match (localTypeAliasTarget(program, name)) {
    some(target) => return moduleTypeIsThreadShareable(
      program,
      importedTypes,
      target,
      visiting
    );
    none => {}
  }
  if (threadShareablePrimitive(name)) return true;
  match (nativeFunctionSignature(name)) {
    some(signature) => return signature.threadContract == "thread.any";
    none => {}
  }
  if (stringStartsWith(name, "readonly ")) {
    const target = name.copyBytes(9, name.byteLength);
    match (genericTypeShape(target)) {
      some(generic) => {
        if (
          (generic.base == "Array" || generic.base == "Set")
          && generic.arguments.length == 1
        ) return moduleTypeIsThreadShareable(
          program,
          importedTypes,
          generic.arguments[0],
          visiting
        );
        if (generic.base == "Map" && generic.arguments.length == 2) {
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
      }
      none => {}
    }
    return false;
  }
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
        sliceName: intrinsicSliceName(elementType),
        elementType,
      }));
    }
    none => return Option<LoweredArray>.none;
  }
}

function intrinsicFixedArrayDeclaration(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in name: String
): Option<LoweredFixedArray> throws String {
  match (fixedArrayShape(name)) {
    some(shape) => {
      const elementType = try lowerModuleTypeName(
        program,
        importedTypes,
        shape.elementType
      );
      return Option.some(LoweredFixedArray({
        name: intrinsicFixedArrayName(elementType, shape.length),
        sliceName: intrinsicSliceName(elementType),
        elementType,
        length: shape.length.copyBytes(0, shape.length.byteLength),
      }));
    }
    none => return Option<LoweredFixedArray>.none;
  }
}

function intrinsicSliceDeclaration(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in name: String
): Option<LoweredSlice> throws String {
  match (genericTypeShape(name)) {
    some(generic) => {
      if (generic.base != "Slice" || generic.arguments.length != 1) {
        return Option<LoweredSlice>.none;
      }
      const elementType = try lowerModuleTypeName(
        program,
        importedTypes,
        generic.arguments[0]
      );
      return Option.some(LoweredSlice({
        name: intrinsicSliceName(elementType),
        elementType,
      }));
    }
    none => return Option<LoweredSlice>.none;
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
  match (intrinsicViewOptionPayloadName(name)) {
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
        name: intrinsicViewOptionName(payload),
        nativeCName: "",
        nativeCUnderlyingType: "",
        variants,
        payloadBearing: true,
        needsDeinit: false,
      }));
    }
    none => {}
  }
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
      const borrowedView = stringStartsWith(generic.arguments[0], "view ");
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
        name: borrowedView
          ? intrinsicViewOptionName(payload)
          : intrinsicOptionName(payload),
        nativeCName: "",
        nativeCUnderlyingType: "",
        variants,
        payloadBearing: true,
        needsDeinit: !borrowedView
          && moduleTypeNeedsCleanup(program, importedTypes, payload),
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
  if (name == "OnceState") {
    let variants = Array<LoweredVariant>();
    variants.push(LoweredVariant({ name: "empty", payload: Option<LoweredType>.none }));
    variants.push(LoweredVariant({ name: "initialized", payload: Option<LoweredType>.none }));
    variants.push(LoweredVariant({ name: "closed", payload: Option<LoweredType>.none }));
    return Option.some(LoweredEnum({
      name: "OnceState",
      nativeCName: "",
      nativeCUnderlyingType: "",
      variants,
      payloadBearing: false,
      needsDeinit: false,
    }));
  }
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

function semanticMethodOwnerName(
  in aggregateName: String,
  in methodName: String
): String {
  let output = TextBuffer();
  output.append(aggregateName);
  output.append(".");
  output.append(methodName);
  return output.finish();
}

function semanticMethodOwnerMatches(
  in ownerName: String,
  in aggregateName: String,
  in methodName: String
): boolean {
  if (ownerName == methodName) return true;
  if (
    ownerName.byteLength
      != aggregateName.byteLength + 1 + methodName.byteLength
  ) return false;
  let index: usize = 0;
  while (index < aggregateName.byteLength) {
    if (ownerName.byteAt(index) != aggregateName.byteAt(index)) return false;
    index = index + 1;
  }
  if (ownerName.byteAt(index) != 46) return false;
  index = index + 1;
  let methodIndex: usize = 0;
  while (methodIndex < methodName.byteLength) {
    if (ownerName.byteAt(index) != methodName.byteAt(methodIndex)) return false;
    index = index + 1;
    methodIndex = methodIndex + 1;
  }
  return true;
}

function ownerReturnTypeName(
  in program: Program,
  in ownerName: String
): Option<String> {
  for (const declaration of program.functions) {
    if (declaration.name == ownerName) {
      return Option.some(declaration.returnType.name.copyBytes(
        0,
        declaration.returnType.name.byteLength
      ));
    }
  }
  let resolved = "";
  for (const aggregate of program.aggregates) {
    for (const method of aggregate.methods) {
      if (!semanticMethodOwnerMatches(
        ownerName,
        aggregate.name,
        method.name
      )) continue;
      if (resolved.byteLength == 0) {
        resolved = method.returnType.name.copyBytes(
          0,
          method.returnType.name.byteLength
        );
      } else if (resolved != method.returnType.name) {
        return Option<String>.none;
      }
    }
  }
  if (resolved.byteLength > 0) return Option.some(move resolved);
  return Option<String>.none;
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
  for (const aggregate of program.aggregates) {
    for (const declaration of aggregate.methods) {
      const qualifiedName = semanticMethodOwnerName(
        aggregate.name,
        declaration.name
      );
      if (qualifiedName != ownerName) continue;
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

function requiredThrowingFunctionResult(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in ownerName: String
): LoweredEnum throws String {
  const result = try throwingFunctionResult(
    program,
    importedTypes,
    ownerName
  );
  return match (result) {
    some(declaration) => declaration;
    none => throw "native value-match try lowering requires one semantically resolved throwing call";
  };
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

function collectTreeMovedNames(
  in program: Program,
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize,
  inout movedNames: Set<String>
): void {
  if (
    tree.nodes[index].kind == ExpressionKind.matchExpression
    && tree.nodes[index].value != "in"
    && tree.nodes[index].children.length > 0
  ) {
    const subject = tree.nodes[index].children[0];
    if (
      tree.nodes[subject].kind == ExpressionKind.identifierExpression
    ) movedNames.add(tree.nodes[subject].value.copyBytes(
      0,
      tree.nodes[subject].value.byteLength
    ));
  }
  if (
    tree.nodes[index].kind == ExpressionKind.unaryExpression
    && tree.nodes[index].value == "move"
    && tree.nodes[index].children.length == 1
  ) {
    const operand = tree.nodes[index].children[0];
    if (
      tree.nodes[operand].kind == ExpressionKind.identifierExpression
    ) movedNames.add(tree.nodes[operand].value.copyBytes(
      0,
      tree.nodes[operand].value.byteLength
    ));
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
      ) movedNames.add(tree.nodes[argument].value.copyBytes(
        0,
        tree.nodes[argument].value.byteLength
      ));
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
      ) {
        let consumesPayload = tree.nodes[enumInput].value == "Option"
          || tree.nodes[enumInput].value == "Result";
        if (
          !consumesPayload
        ) {
          for (const declaration of program.enums) {
            if (declaration.name != tree.nodes[enumInput].value) continue;
            for (const variant of declaration.variants) {
              if (variant.name == tree.nodes[callee].value) {
                consumesPayload = true;
              }
            }
          }
        }
        if (consumesPayload) movedNames.add(tree.nodes[payload].value.copyBytes(
          0,
          tree.nodes[payload].value.byteLength
        ));
      }
    }
    if (
      tree.nodes[callee].kind == ExpressionKind.memberExpression
      && tree.nodes[callee].children.length == 1
    ) {
      const receiver = tree.nodes[callee].children[0];
      let consumesReceiver = resolvedCallReceiverMode(
        evidence,
        tree,
        index
      ) == "move" || tree.nodes[callee].value == "freeze";
      if (tree.nodes[callee].value == "finish") {
        match (resolvedExpressionTypeName(evidence, tree, receiver)) {
          some(typeName) => consumesReceiver = typeName == "TextBuffer";
          none => {}
        }
      }
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
      ) movedNames.add(tree.nodes[receiver].value.copyBytes(
        0,
        tree.nodes[receiver].value.byteLength
      ));
    }
    if (
      tree.nodes[callee].kind == ExpressionKind.memberExpression
      && tree.nodes[callee].value == "push"
      && tree.nodes[index].children.length == 2
    ) {
      const argument = tree.nodes[index].children[1];
      if (
        tree.nodes[argument].kind == ExpressionKind.identifierExpression
      ) movedNames.add(tree.nodes[argument].value.copyBytes(
        0,
        tree.nodes[argument].value.byteLength
      ));
    }
    if (tree.nodes[callee].kind == ExpressionKind.identifierExpression) {
      match (genericTypeShape(tree.nodes[callee].value)) {
        some(generic) => {
          if (generic.base == "Array" && generic.arguments.length == 1) {
            let sharedArcElement = false;
            for (const declaration of program.aggregates) {
              if (
                declaration.name == generic.arguments[0]
                && declaration.kind == DeclarationKind.classDeclaration
              ) sharedArcElement = true;
            }
            if (!sharedArcElement) {
              let argumentIndex: usize = 1;
              while (argumentIndex < tree.nodes[index].children.length) {
                const argument = tree.nodes[index].children[argumentIndex];
                if (
                  tree.nodes[argument].kind == ExpressionKind.identifierExpression
                ) movedNames.add(tree.nodes[argument].value.copyBytes(
                  0,
                  tree.nodes[argument].value.byteLength
                ));
                argumentIndex = argumentIndex + 1;
              }
            }
          }
        }
        none => {}
      }
      if (tree.nodes[index].children.length == 2) {
        const initializer = tree.nodes[index].children[1];
        if (tree.nodes[initializer].kind == ExpressionKind.objectExpression) {
          for (const field of tree.nodes[initializer].children) {
            if (
              tree.nodes[field].kind == ExpressionKind.identifierExpression
            ) movedNames.add(tree.nodes[field].value.copyBytes(
              0,
              tree.nodes[field].value.byteLength
            ));
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
          ) movedNames.add(tree.nodes[argument].value.copyBytes(
            0,
            tree.nodes[argument].value.byteLength
          ));
          parameter = parameter + 1;
        }
      }
    }
  }
  for (const child of tree.nodes[index].children) {
    collectTreeMovedNames(program, evidence, tree, child, inout movedNames);
  }
}

function treeMovesName(
  in program: Program,
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize,
  in name: String
): boolean {
  let movedNames = Set<String>();
  collectTreeMovedNames(program, evidence, tree, index, inout movedNames);
  return movedNames.has(name);
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

function collectSyntaxMovedNames(
  in program: Program,
  in evidence: ModuleSemanticEvidence,
  in expression: ExpressionSyntax,
  inout movedNames: Set<String>
): void {
  match (in expression.tree) {
    some(tree) => {
      const root = tree.root;
      collectTreeMovedNames(
        program,
        evidence,
        tree,
        root,
        inout movedNames
      );
    }
    none => {}
  }
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

struct CleanupMoveIndex {
  movedNames: Set<String>;
  movedThreadBindingOffsets: Array<usize>;
  hasControlFlow: boolean;
}

function collectDirectStatementMovedNames(
  in program: Program,
  in evidence: ModuleSemanticEvidence,
  in statement: Statement,
  inout movedNames: Set<String>
): void {
  match (in statement.expression) {
    some(expression) => {
      if (
        statement.kind == StatementKind.returnStatement
        || statement.kind == StatementKind.throwStatement
        || statement.kind == StatementKind.selectStatement
        || statement.kind == StatementKind.yieldStatement
      ) {
        match (in expression.tree) {
          some(tree) => {
            if (
              tree.nodes[tree.root].kind
                == ExpressionKind.identifierExpression
            ) movedNames.add(tree.nodes[tree.root].value.copyBytes(
              0,
              tree.nodes[tree.root].value.byteLength
            ));
          }
          none => {}
        }
      }
      collectSyntaxMovedNames(
        program,
        evidence,
        expression,
        inout movedNames
      );
    }
    none => {}
  }
  match (in statement.secondExpression) {
    some(expression) => {
      if (statement.kind == StatementKind.assignmentStatement) {
        match (in expression.tree) {
          some(tree) => {
            if (
              tree.nodes[tree.root].kind
                == ExpressionKind.identifierExpression
            ) movedNames.add(tree.nodes[tree.root].value.copyBytes(
              0,
              tree.nodes[tree.root].value.byteLength
            ));
          }
          none => {}
        }
      }
      collectSyntaxMovedNames(
        program,
        evidence,
        expression,
        inout movedNames
      );
    }
    none => {}
  }
}

function cleanupMoveIndex(
  in program: Program,
  in evidence: ModuleSemanticEvidence,
  in arena: StatementArena,
  in expressions: Array<LoweredExpression>
): CleanupMoveIndex {
  let movedNames = Set<String>();
  let hasControlFlow = false;
  for (const statement of arena.nodes) {
    collectDirectStatementMovedNames(
      program,
      evidence,
      statement,
      inout movedNames
    );
    if (
      statement.kind == StatementKind.ifStatement
      || statement.kind == StatementKind.whileStatement
    ) hasControlFlow = true;
  }
  for (const expression of expressions) {
    if (
      expression.kind != LoweredExpressionKind.moveValue
      || expression.children.length != 1
    ) continue;
    const operand = expression.children[0];
    const root = loweredExpressionStorageRoot(expressions, operand);
    if (root.byteLength > 0) movedNames.add(move root);
  }
  let movedThreadBindingOffsets = Array<usize>();
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
        captureIndex < expression.captureBindingOffsets.length
        && captureChild < expression.children.length
      ) {
        const value = expression.children[captureChild];
        if (
          expressions[value].kind == LoweredExpressionKind.moveValue
          && expressions[value].children.length == 1
        ) movedThreadBindingOffsets.push(
          expression.captureBindingOffsets[captureIndex]
        );
      }
      captureLabel = captureLabel + 2;
      captureChild = captureChild + 1;
      captureIndex = captureIndex + 1;
    }
  }
  return CleanupMoveIndex({
    movedNames: move movedNames,
    movedThreadBindingOffsets: move movedThreadBindingOffsets,
    hasControlFlow,
  });
}

function cleanupIndexMovesBinding(
  in index: CleanupMoveIndex,
  in name: String,
  bindingOffset: usize
): boolean {
  if (index.movedNames.has(name)) return true;
  for (const movedOffset of index.movedThreadBindingOffsets) {
    if (movedOffset == bindingOffset) return true;
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
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in arena: StatementArena,
  index: usize,
  in cleanups: Array<LoweredCleanup>,
  inout statements: Array<LoweredStatement>,
  loweredIndex: usize
): void {
  if (
    statements[loweredIndex].kind
      != LoweredStatementKind.assignmentStatement
  ) return;
  match (in arena.nodes[index].expression) {
    some(expression) => match (in expression.tree) {
      some(tree) => {
        if (
          tree.nodes[tree.root].kind == ExpressionKind.identifierExpression
        ) {
          for (const cleanup of cleanups) {
            if (tree.nodes[tree.root].value == cleanup.name) {
              statements[loweredIndex].cleanups.push(copyCleanup(cleanup));
              return;
            }
          }
          return;
        }
        if (tree.nodes[tree.root].kind != ExpressionKind.memberExpression) {
          return;
        }
        let memberType = Option<LoweredType>.none;
        match (in statements[loweredIndex].type) {
          some(type) => memberType = Option.some(LoweredType({
              kind: type.kind,
              name: type.name.copyBytes(0, type.name.byteLength),
            }));
          none => {}
        }
        match (memberType) {
          some(replacementType) => {
            if (!moduleTypeNeedsCleanup(
              program,
              importedTypes,
              replacementType
            )) return;
            const replacementCleanup = LoweredCleanup({
              name: "",
              type: move replacementType,
              guard: "",
            });
            statements[loweredIndex].cleanups.push(move replacementCleanup);
          }
          none => {}
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
  in moveIndex: CleanupMoveIndex,
  inout statements: Array<LoweredStatement>,
  inout liveFlags: Array<LoweredLiveFlag>,
  forceMoveLiveGuards: boolean,
  insideLoop: boolean,
  in loopCleanups: Array<LoweredCleanup>
): void throws String {
  if (
    statements[loweredIndex].kind == LoweredStatementKind.blockStatement
    && statements[loweredIndex].labels.length == 1
    && statements[loweredIndex].labels[0] == "destructure-normalized"
  ) return;
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
      moveIndex,
      inout statements,
      inout liveFlags,
      forceMoveLiveGuards,
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
      moveIndex,
      inout statements,
      inout liveFlags,
      forceMoveLiveGuards,
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
              let patternCleanups = Array<LoweredCleanup>();
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
                const bindingName = statements[loweredArm].labels[0]
                  .copyBytes(
                    0,
                    statements[loweredArm].labels[0].byteLength
                  );
                const moved = cleanupIndexMovesBinding(
                  moveIndex,
                  bindingName,
                  tree.nodes[arm].offset
                );
                let guard = "";
                if (
                  moved
                  && (forceMoveLiveGuards || moveIndex.hasControlFlow)
                ) {
                  guard = ownerLiveFlag(bindingName);
                  statements[loweredArm].liveFlag = guard.copyBytes(
                    0,
                    guard.byteLength
                  );
                  liveFlags.push(LoweredLiveFlag({
                    owner: bindingName.copyBytes(0, bindingName.byteLength),
                    name: guard.copyBytes(0, guard.byteLength),
                    parameter: false,
                  }));
                }
                if (!moved || guard.byteLength > 0) {
                  const cleanup = LoweredCleanup({
                    name: move bindingName,
                    type: move payloadType,
                    guard: move guard,
                  });
                  armLive.push(copyCleanup(cleanup));
                  patternCleanups.push(move cleanup);
                }
              }
              if (
                consuming
                && tree.nodes[arm].value == "_"
              ) {
                const matchType = match (in statements[loweredIndex].type) {
                  some(type) => LoweredType({
                    kind: type.kind,
                    name: type.name.copyBytes(0, type.name.byteLength),
                  });
                  none => throw "native cleanup planning lost a wildcard match subject type";
                };
                if (moduleTypeNeedsCleanup(program, importedTypes, matchType)) {
                  const cleanup = LoweredCleanup({
                    name: `_z_stage1_match_${loweredIndex}`,
                    type: move matchType,
                    guard: "",
                  });
                  armLive.push(copyCleanup(cleanup));
                  patternCleanups.push(move cleanup);
                }
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
                moveIndex,
                inout statements,
                inout liveFlags,
                forceMoveLiveGuards,
                insideLoop,
                loopCleanups
              );
              if (
                sequenceFallsThrough(arena, sourceRoots)
                && loweredSequenceFallsThrough(statements, loweredRoots)
              ) {
                for (const cleanup of patternCleanups) {
                  statements[loweredArm].cleanups.push(copyCleanup(cleanup));
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
      moveIndex,
      inout statements,
      inout liveFlags,
      forceMoveLiveGuards,
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
        moveIndex,
        inout statements,
        inout liveFlags,
        forceMoveLiveGuards,
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
  in moveIndex: CleanupMoveIndex,
  inout statements: Array<LoweredStatement>,
  inout liveFlags: Array<LoweredLiveFlag>,
  forceMoveLiveGuards: boolean,
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
            const moved = cleanupIndexMovesBinding(
              moveIndex,
              bindingName,
              bindingOffset
            );
            let guard = "";
            if (
              moved
              && (forceMoveLiveGuards || moveIndex.hasControlFlow)
            ) {
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
      arena.nodes[sourceIndex].kind == StatementKind.destructureStatement
      && statements[loweredIndex].kind == LoweredStatementKind.blockStatement
      && loweredStatementHasLabel(
        statements[loweredIndex],
        "destructure-normalized"
      )
    ) {
      let destructureChildren = Array<usize>();
      for (const child of statements[loweredIndex].children) {
        destructureChildren.push(child);
      }
      for (const child of destructureChildren) {
        if (
          statements[child].kind != LoweredStatementKind.localStatement
          || !loweredStatementHasLabel(
            statements[child],
            "destructure-binding"
          )
        ) continue;
        const ownedType = match (in statements[child].type) {
          some(type) => LoweredType({
            kind: type.kind,
            name: type.name.copyBytes(0, type.name.byteLength),
          });
          none => throw "native cleanup planning lost a destructured binding type";
        };
        let bindingOffset: usize = 0;
        let borrowedView = false;
        for (const binding of arena.nodes[sourceIndex].objectBindings) {
          if (binding.bindingName != statements[child].name) continue;
          bindingOffset = binding.bindingOffset;
          for (const resolution of evidence.bindingResolutions) {
            if (
              resolution.offset == binding.bindingOffset
              && resolution.name == binding.bindingName
              && stringStartsWith(resolution.typeName, "view ")
            ) borrowedView = true;
          }
        }
        if (
          borrowedView
          || !moduleTypeNeedsCleanup(program, importedTypes, ownedType)
        ) continue;
        const bindingName = statements[child].name.copyBytes(
          0,
          statements[child].name.byteLength
        );
        const moved = cleanupIndexMovesBinding(
          moveIndex,
          bindingName,
          bindingOffset
        );
        let guard = "";
        if (moved && (forceMoveLiveGuards || moveIndex.hasControlFlow)) {
          guard = ownerLiveFlag(bindingName);
          statements[child].liveFlag = guard.copyBytes(
            0,
            guard.byteLength
          );
          liveFlags.push(LoweredLiveFlag({
            owner: bindingName.copyBytes(0, bindingName.byteLength),
            name: guard.copyBytes(0, guard.byteLength),
            parameter: false,
          }));
        }
        if (!moved || guard.byteLength > 0) {
          const cleanup = LoweredCleanup({
            name: bindingName.copyBytes(0, bindingName.byteLength),
            type: move ownedType,
            guard: move guard,
          });
          live.push(copyCleanup(cleanup));
          if (insideLoop) loopCleanups.push(copyCleanup(cleanup));
          introduced.push(move cleanup);
        }
      }
    } else if (
      arena.nodes[sourceIndex].kind == StatementKind.assignmentStatement
    ) {
      attachReplacementCleanup(
        program,
        importedTypes,
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
      moveIndex,
      inout statements,
      inout liveFlags,
      forceMoveLiveGuards,
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
      const owner = loweredExpressionStorageRoot(expressions, operand);
      if (owner.byteLength > 0) {
        for (const flag of liveFlags) {
          if (flag.owner == owner) {
            expressions[index].value = flag.name.copyBytes(
              0,
              flag.name.byteLength
            );
          }
        }
      }
    }
    index = index + 1;
  }
}

function loweredExpressionStorageRoot(
  in expressions: Array<LoweredExpression>,
  index: usize
): String {
  if (expressions[index].kind == LoweredExpressionKind.localValue) {
    return expressions[index].value.copyBytes(
      0,
      expressions[index].value.byteLength
    );
  }
  if (expressions[index].kind == LoweredExpressionKind.receiverValue) {
    return "this";
  }
  if (
    (
      expressions[index].kind == LoweredExpressionKind.fieldValue
      || expressions[index].kind == LoweredExpressionKind.arrayIndex
      || expressions[index].kind == LoweredExpressionKind.arrayMutableIndex
    )
    && expressions[index].children.length > 0
  ) {
    const receiver = expressions[index].children[0];
    return loweredExpressionStorageRoot(expressions, receiver);
  }
  return "";
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
          if (parameter.type.kind == LoweredTypeKind.foreignObjCType) {
            expressions[expressionIndex].labels.push("foreignObjC");
          }
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

function objectiveCRegistrationResolutionIndex(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): usize {
  let planIndex: usize = 0;
  while (planIndex < evidence.objectiveCRegistrations.length) {
    if (
      evidence.objectiveCRegistrations[planIndex].offset
        == tree.nodes[index].offset
      && evidence.objectiveCRegistrations[planIndex].line
        == tree.nodes[index].line
      && evidence.objectiveCRegistrations[planIndex].column
        == tree.nodes[index].column
    ) return planIndex;
    planIndex = planIndex + 1;
  }
  return evidence.objectiveCRegistrations.length;
}

function objectiveCAdapterResolutionIndex(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): usize {
  let planIndex: usize = 0;
  while (planIndex < evidence.objectiveCAdapters.length) {
    if (
      evidence.objectiveCAdapters[planIndex].offset == tree.nodes[index].offset
      && evidence.objectiveCAdapters[planIndex].line == tree.nodes[index].line
      && evidence.objectiveCAdapters[planIndex].column
        == tree.nodes[index].column
    ) return planIndex;
    planIndex = planIndex + 1;
  }
  return evidence.objectiveCAdapters.length;
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

function sourceExpressionRootsInThis(
  in tree: ExpressionTree,
  index: usize
): boolean {
  if (tree.nodes[index].kind == ExpressionKind.identifierExpression) {
    return tree.nodes[index].value == "this";
  }
  if (
    tree.nodes[index].kind == ExpressionKind.memberExpression
    && tree.nodes[index].children.length == 1
  ) {
    const receiver = tree.nodes[index].children[0];
    return sourceExpressionRootsInThis(tree, receiver);
  }
  return false;
}

function expressionBorrowsStoredReference(
  in tree: ExpressionTree,
  index: usize
): boolean {
  const kind = tree.nodes[index].kind;
  return kind == ExpressionKind.identifierExpression
    || kind == ExpressionKind.argumentBindingExpression
    || kind == ExpressionKind.argumentReferenceExpression
    || kind == ExpressionKind.memberExpression
    || kind == ExpressionKind.indexExpression;
}

function wrapOwnedStorage(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in tree: ExpressionTree,
  input: usize,
  in payloadTypeName: String,
  value: usize,
  inout output: Array<LoweredExpression>
): usize throws String {
  if (payloadTypeName == "null") return value;
  const payloadTypeOutcome = attempt lowerModuleTypeName(
    program,
    importedTypes,
    payloadTypeName
  );
  const payloadType = match (payloadTypeOutcome) {
    success(type) => type;
    failure(message) => throw
      `${message} while storing ${payloadTypeName} for expression at ${tree.nodes[input].line}:${tree.nodes[input].column}`;
  };
  return wrapOwnedStorageType(
    program,
    importedTypes,
    tree,
    input,
    payloadType,
    value,
    inout output
  );
}

function wrapOwnedStorageType(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in tree: ExpressionTree,
  input: usize,
  in payloadType: LoweredType,
  value: usize,
  inout output: Array<LoweredExpression>
): usize {
  if (!moduleTypeNeedsCleanup(program, importedTypes, payloadType)) {
    return value;
  }
  if (
    moduleTypeRetainsCapturedIdentity(payloadType)
    && expressionBorrowsStoredReference(tree, input)
  ) {
    if (output[value].kind == LoweredExpressionKind.retainValue) {
      return value;
    }
    let children = Array<usize>();
    children.push(value);
    return pushExpression(
      inout output,
      LoweredExpressionKind.retainValue,
      payloadType.name,
      move children,
      Array<String>()
    );
  }
  return wrapImplicitOwnedTransfer(tree, input, value, inout output);
}

function resolvedCallTarget(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): Option<String> {
  const resolutionIndex = resolvedCallResolutionIndex(
    evidence,
    tree,
    index
  );
  if (resolutionIndex >= evidence.callResolutions.length) {
    return Option<String>.none;
  }
  const resolution = view evidence.callResolutions[resolutionIndex];
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

function callResolutionIndexForOffset(
  in evidence: ModuleSemanticEvidence,
  offset: usize
): usize {
  const found = evidence.callResolutionIndices.get(offset);
  return match (in found) {
    some(index) => index;
    none => evidence.callResolutions.length;
  };
}

function resolvedCallResolutionIndex(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): usize {
  const resolutionIndex = callResolutionIndexForOffset(
    evidence,
    tree.nodes[index].offset
  );
  if (resolutionIndex >= evidence.callResolutions.length) {
    return evidence.callResolutions.length;
  }
  const resolution = view evidence.callResolutions[resolutionIndex];
  if (
    resolution.line == tree.nodes[index].line
    && resolution.column == tree.nodes[index].column
  ) return resolutionIndex;
  return evidence.callResolutions.length;
}

function resolvedCallKind(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): String {
  const resolutionIndex = resolvedCallResolutionIndex(
    evidence,
    tree,
    index
  );
  if (resolutionIndex >= evidence.callResolutions.length) return "";
  const resolution = view evidence.callResolutions[resolutionIndex];
  return resolution.kind.copyBytes(0, resolution.kind.byteLength);
}

function resolvedObjectiveCSelector(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): String {
  const resolutionIndex = resolvedCallResolutionIndex(
    evidence,
    tree,
    index
  );
  if (resolutionIndex >= evidence.callResolutions.length) return "";
  const resolution = view evidence.callResolutions[resolutionIndex];
  return resolution.objectiveCSelector.copyBytes(
    0,
    resolution.objectiveCSelector.byteLength
  );
}

function resolvedObjectiveCReceiverNativeType(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): String {
  const resolutionIndex = resolvedCallResolutionIndex(
    evidence,
    tree,
    index
  );
  if (resolutionIndex >= evidence.callResolutions.length) return "";
  const resolution = view evidence.callResolutions[resolutionIndex];
  return resolution.objectiveCReceiverNativeType.copyBytes(
    0,
    resolution.objectiveCReceiverNativeType.byteLength
  );
}

function resolvedObjectiveCParameterNativeTypes(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): Array<String> {
  const resolutionIndex = resolvedCallResolutionIndex(
    evidence,
    tree,
    index
  );
  let types = Array<String>();
  if (resolutionIndex >= evidence.callResolutions.length) return types;
  const resolution = view evidence.callResolutions[resolutionIndex];
  for (const typeName of resolution.objectiveCParameterNativeTypes) {
    types.push(typeName.copyBytes(0, typeName.byteLength));
  }
  return types;
}

function nativeTypeIsObjectiveCBlock(in typeName: String): boolean {
  let index: usize = 0;
  while (index + 1 < typeName.byteLength) {
    if (typeName.byteAt(index) == 40 && typeName.byteAt(index + 1) == 94) {
      return true;
    }
    index = index + 1;
  }
  return false;
}

function resolvedGenericMethodSuffix(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): String throws String {
  const resolutionIndex = resolvedCallResolutionIndex(
    evidence,
    tree,
    index
  );
  if (resolutionIndex >= evidence.callResolutions.length) return "";
  const resolution = view evidence.callResolutions[resolutionIndex];
  if (
    resolution.callableTypeParameterCount == 0
    || (
      resolution.kind != "method"
      && resolution.kind != "staticMethod"
    )
  ) return "";
  return try genericCallableSpecializationSuffix(
    program,
    importedTypes,
    resolution.typeArguments
  );
}

function resolvedGenericFunctionSuffix(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): String throws String {
  const resolutionIndex = resolvedCallResolutionIndex(
    evidence,
    tree,
    index
  );
  if (resolutionIndex >= evidence.callResolutions.length) return "";
  const resolution = view evidence.callResolutions[resolutionIndex];
  if (
    resolution.callableTypeParameterCount == 0
    || resolution.kind != "function"
  ) return "";
  return try genericCallableSpecializationSuffix(
    program,
    importedTypes,
    resolution.typeArguments
  );
}

function resolvedStaticMethodOwnerType(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): Option<LoweredType> throws String {
  const resolutionIndex = resolvedCallResolutionIndex(
    evidence,
    tree,
    index
  );
  if (
    resolutionIndex >= evidence.callResolutions.length
    || evidence.callResolutions[resolutionIndex].kind != "staticMethod"
    || tree.nodes[index].children.length == 0
  ) return Option<LoweredType>.none;
  const resolution = view evidence.callResolutions[resolutionIndex];
  const callee = tree.nodes[index].children[0];
  if (
    tree.nodes[callee].kind != ExpressionKind.memberExpression
    || tree.nodes[callee].children.length != 1
  ) throw "native static-method lowering requires a member call";
  const ownerInput = tree.nodes[callee].children[0];
  const sourceOwner = typeExpressionName(tree, ownerInput);
  if (sourceOwner.byteLength == 0) {
    throw "native static-method lowering lost its source owner type";
  }
  const ownerTypeArgumentCount = resolution.typeArguments.length
    - resolution.callableTypeParameterCount;
  if (ownerTypeArgumentCount > 0) {
    let ownerTypeArguments = Array<String>();
    let argumentIndex: usize = 0;
    while (argumentIndex < ownerTypeArgumentCount) {
      ownerTypeArguments.push(resolution.typeArguments[argumentIndex]
        .copyBytes(
          0,
          resolution.typeArguments[argumentIndex].byteLength
        ));
      argumentIndex = argumentIndex + 1;
    }
    const concreteOwner = concreteGenericTypeName(
      sourceOwner,
      ownerTypeArguments
    );
    const concrete = attempt lowerModuleTypeName(
      program,
      importedTypes,
      concreteOwner
    );
    match (concrete) {
      success(type) => return Option.some(type);
      failure(_) => {
        const message =
          `native static-method lowering could not materialize owner ${concreteOwner}`;
        throw message;
      }
    }
  }
  const ownerType = try lowerModuleTypeName(
    program,
    importedTypes,
    sourceOwner
  );
  return Option.some(ownerType);
}

function resolvedCallIsAsynchronous(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): boolean {
  const resolutionIndex = resolvedCallResolutionIndex(
    evidence,
    tree,
    index
  );
  return resolutionIndex < evidence.callResolutions.length
    && evidence.callResolutions[resolutionIndex].asynchronous;
}

function resolvedCallReceiverMode(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): String {
  const resolutionIndex = resolvedCallResolutionIndex(
    evidence,
    tree,
    index
  );
  if (resolutionIndex >= evidence.callResolutions.length) return "";
  const resolution = view evidence.callResolutions[resolutionIndex];
  return resolution.receiverMode.copyBytes(
    0,
    resolution.receiverMode.byteLength
  );
}

function resolvedForeignCallTarget(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): Option<String> {
  const resolutionIndex = resolvedCallResolutionIndex(
    evidence,
    tree,
    index
  );
  if (resolutionIndex >= evidence.callResolutions.length) {
    return Option<String>.none;
  }
  const resolution = view evidence.callResolutions[resolutionIndex];
  if (resolution.kind != "foreign") return Option<String>.none;
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

function resolvedForeignArguments(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): Array<ModuleForeignArgument> {
  const resolutionIndex = resolvedCallResolutionIndex(
    evidence,
    tree,
    index
  );
  if (resolutionIndex >= evidence.callResolutions.length) {
    return Array<ModuleForeignArgument>();
  }
  const resolution = view evidence.callResolutions[resolutionIndex];
  if (
    resolution.kind != "foreign"
    || resolution.foreignSuccessValues.length > 0
  ) return Array<ModuleForeignArgument>();
  let arguments = Array<ModuleForeignArgument>();
  for (const argument of resolution.foreignArguments) {
    arguments.push(ModuleForeignArgument({
      kind: argument.kind.copyBytes(0, argument.kind.byteLength),
      source: argument.source,
      value: argument.value.copyBytes(0, argument.value.byteLength),
      mode: argument.mode.copyBytes(0, argument.mode.byteLength),
      thread: argument.thread.copyBytes(0, argument.thread.byteLength),
    }));
  }
  return arguments;
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
  let containsRawFunction = false;
  for (const declaration of program.functions) {
    if (declaration.rawLanguage.byteLength > 0) {
      containsRawFunction = true;
      break;
    }
  }
  if (containsRawFunction) {
    for (const declaration of program.imports) {
      if (
        !stringEndsWithBytes(declaration.header, ".h")
        && !stringEndsWithBytes(declaration.header, ".hh")
        && !stringEndsWithBytes(declaration.header, ".hpp")
      ) continue;
      try requireSafeForeignHeader(declaration.header);
      if (!containsString(headers, declaration.header)) {
        headers.push(declaration.header.copyBytes(
          0,
          declaration.header.byteLength
        ));
      }
    }
  }
  for (const resolution of evidence.callResolutions) {
    if (
      resolution.kind != "foreign"
      && resolution.objectiveCSelector.byteLength == 0
    ) continue;
    try requireSafeForeignHeader(resolution.foreignHeader);
    if (!containsString(headers, resolution.foreignHeader)) {
      headers.push(resolution.foreignHeader.copyBytes(
        0,
        resolution.foreignHeader.byteLength
      ));
    }
    if (resolution.objectiveCSelector.byteLength > 0) continue;
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
    let parameterModes = Array<String>();
    for (const parameterMode of resolution.parameterModes) {
      parameterModes.push(parameterMode.copyBytes(
        0,
        parameterMode.byteLength
      ));
    }
    let arguments = Array<ModuleForeignArgument>();
    for (const argument of resolution.foreignArguments) {
      arguments.push(ModuleForeignArgument({
        kind: argument.kind.copyBytes(0, argument.kind.byteLength),
        source: argument.source,
        value: argument.value.copyBytes(0, argument.value.byteLength),
        mode: argument.mode.copyBytes(0, argument.mode.byteLength),
        thread: argument.thread.copyBytes(0, argument.thread.byteLength),
      }));
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
      parameterModes,
      arguments,
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
  if (mode == ReceiverMode.move) return LoweredParameterMode.value;
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
  const resolutionIndex = resolvedCallResolutionIndex(
    evidence,
    tree,
    index
  );
  if (resolutionIndex < evidence.callResolutions.length) {
    const resolution = view evidence.callResolutions[resolutionIndex];
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
  in program: Program,
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): Array<String> {
  const resolutionIndex = resolvedCallResolutionIndex(
    evidence,
    tree,
    index
  );
  if (resolutionIndex < evidence.callResolutions.length) {
    const resolution = view evidence.callResolutions[resolutionIndex];
    if (
      resolution.kind == "function"
      && resolution.callableTypeParameterCount > 0
      && tree.nodes[index].children.length > 0
    ) {
      const callee = tree.nodes[index].children[0];
      if (
        tree.nodes[callee].kind == ExpressionKind.identifierExpression
      ) {
        for (const declaration of program.functions) {
          if (
            declaration.name != tree.nodes[callee].value
            || declaration.typeParameters.length
              != resolution.callableTypeParameterCount
            || resolution.typeArguments.length
              != resolution.callableTypeParameterCount
          ) continue;
          let substitutions = Array<NativeValueBinding>();
          let parameter: usize = 0;
          while (parameter < declaration.typeParameters.length) {
            addValueBinding(
              inout substitutions,
              declaration.typeParameters[parameter].name,
              resolution.typeArguments[parameter]
            );
            parameter = parameter + 1;
          }
          let types = Array<String>();
          for (const declaredParameter of declaration.parameters) {
            types.push(substituteGenericType(
              declaredParameter.type.name,
              substitutions
            ));
          }
          return types;
        }
      }
    }
    let types = Array<String>();
    for (const type of resolution.parameterTypes) {
      types.push(type.copyBytes(0, type.byteLength));
    }
    if (types.length > 0) return types;
  }
  if (tree.nodes[index].children.length > 0) {
    const callee = tree.nodes[index].children[0];
    if (tree.nodes[callee].kind == ExpressionKind.identifierExpression) {
      for (const declaration of program.functions) {
        if (declaration.name != tree.nodes[callee].value) continue;
        let types = Array<String>();
        for (const parameter of declaration.parameters) {
          types.push(parameter.type.name.copyBytes(
            0,
            parameter.type.name.byteLength
          ));
        }
        return types;
      }
    }
  }
  return Array<String>();
}

function resolvedCallReturnTypeName(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): Option<String> {
  const resolutionIndex = resolvedCallResolutionIndex(
    evidence,
    tree,
    index
  );
  if (resolutionIndex >= evidence.callResolutions.length) {
    return Option<String>.none;
  }
  const resolution = view evidence.callResolutions[resolutionIndex];
  if (
    resolution.line != tree.nodes[index].line
    || resolution.column != tree.nodes[index].column
    || resolution.returnType.byteLength == 0
  ) return Option<String>.none;
  return Option.some(resolution.returnType.copyBytes(
    0,
    resolution.returnType.byteLength
  ));
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
  in statements: Array<LoweredStatement>,
  statementStart: usize,
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
    let typeName = "";
    match (namedValueTypeName(
      program,
      evidence,
      ownerName,
      captureName,
      useOffset
    )) {
      some(name) => typeName = move name;
      // Match payloads and other compiler-owned temporaries are introduced
      // while lowering the closure body and are not lexical captures.
      none => {}
    }
    if (typeName.byteLength == 0) {
      index = index + 1;
      continue;
    }
    const type = try lowerModuleTypeName(
      program,
      importedTypes,
      typeName
    );
    if (
      moduleTypeNeedsCleanup(program, importedTypes, type)
      && loweredRangeMovesName(expressions, start, captureName)
    ) {
      throw `native Mutex.withLock cannot consume ownership-bearing capture ${captureName}`;
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

function collectObjCPoolClosureCaptures(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in ownerName: String,
  in expressions: Array<LoweredExpression>,
  start: usize,
  useOffset: usize
): Array<LoweredClosureCapture> throws String {
  let captures = Array<LoweredClosureCapture>();
  let index = start;
  while (index < expressions.length) {
    if (expressions[index].kind == LoweredExpressionKind.receiverValue) {
      throw "native objc.pool closures cannot capture `this` yet";
    }
    if (expressions[index].kind != LoweredExpressionKind.localValue) {
      index = index + 1;
      continue;
    }
    let directCallee = false;
    let parent = start;
    while (parent < expressions.length) {
      if (
        expressions[parent].kind == LoweredExpressionKind.directCall
        && expressions[parent].children.length > 0
        && expressions[parent].children[0] == index
      ) directCallee = true;
      parent = parent + 1;
    }
    if (directCallee) {
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
      none => throw `native objc.pool cannot resolve capture ${captureName}`;
    };
    const type = try lowerModuleTypeName(
      program,
      importedTypes,
      typeName
    );
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

function collectCallableBlockCaptures(
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
      throw "native block callable closures cannot capture `this` yet";
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
    match (resolvedType) {
      some(type) => captures.push(LoweredClosureCapture({
        name: move captureName,
        owned: moduleTypeNeedsCleanup(program, importedTypes, type),
        type,
      }));
      none => match (namedValueTypeName(
        program,
        evidence,
        ownerName,
        captureName,
        useOffset
      )) {
        some(typeName) => {
          const type = try lowerModuleTypeName(
            program,
            importedTypes,
            typeName
          );
          captures.push(LoweredClosureCapture({
            name: move captureName,
            owned: moduleTypeNeedsCleanup(program, importedTypes, type),
            type,
          }));
        }
        // Imported namespaces and direct compiler/runtime helpers are not
        // lexical captures even when they lower through a local C spelling.
        none => {}
      }
    }
    index = index + 1;
  }
  return captures;
}

function resolvedExpressionResolutionIndex(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): usize {
  const found = evidence.expressionResolutionIndices.get(
    tree.nodes[index].offset
  );
  match (in found) {
    some(resolutionIndex) => return resolutionIndex;
    none => return evidence.expressionResolutions.length;
  }
}

function resolvedExpressionTypeName(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): Option<String> {
  const resolutionIndex = resolvedExpressionResolutionIndex(
    evidence,
    tree,
    index
  );
  if (resolutionIndex >= evidence.expressionResolutions.length) {
    return Option<String>.none;
  }
  const resolution = view evidence.expressionResolutions[resolutionIndex];
  if (
    resolution.line != tree.nodes[index].line
    || resolution.column != tree.nodes[index].column
  ) return Option<String>.none;
  return Option.some(resolution.typeName.copyBytes(
    0,
    resolution.typeName.byteLength
  ));
}

// Native semantic evidence intentionally omits a few expression types that can
// be recovered without ambiguity from lexical bindings. Lowering needs that
// recovery for type-directed operators such as String equality; otherwise a
// borrowed element from readonly Array<String> falls back to a C struct `==`.
function loweringExpressionTypeName(
  in program: Program,
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): Option<String> {
  match (resolvedExpressionTypeName(evidence, tree, index)) {
    some(name) => return Option.some(move name);
    none => {}
  }
  if (tree.nodes[index].kind == ExpressionKind.identifierExpression) {
    const name = tree.nodes[index].value.copyBytes(
      0,
      tree.nodes[index].value.byteLength
    );
    const offset = tree.nodes[index].offset;
    return namedValueTypeName(
      program,
      evidence,
      "",
      name,
      offset
    );
  }
  if (
    tree.nodes[index].kind == ExpressionKind.indexExpression
    && tree.nodes[index].children.length > 0
  ) {
    const owner = tree.nodes[index].children[0];
    match (loweringExpressionTypeName(program, evidence, tree, owner)) {
      some(ownerType) => {
        let container = ownerType;
        if (stringStartsWith(container, "view ")) {
          container = container.copyBytes(5, container.byteLength);
        }
        if (stringStartsWith(container, "readonly ")) {
          container = container.copyBytes(9, container.byteLength);
        }
        match (genericTypeShape(container)) {
          some(generic) => if (
            generic.arguments.length == 1
            && (generic.base == "Array" || generic.base == "Slice")
          ) return Option.some(generic.arguments[0].copyBytes(
            0,
            generic.arguments[0].byteLength
          ));
          none => {}
        }
        match (fixedArrayShape(container)) {
          some(array) => return Option.some(array.elementType.copyBytes(
            0,
            array.elementType.byteLength
          ));
          none => {}
        }
      }
      none => {}
    }
  }
  return Option<String>.none;
}

function resolvedMemberReceiverTypeIs(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  member: usize,
  in expected: String
): boolean {
  if (tree.nodes[member].children.length != 1) return false;
  const receiver = tree.nodes[member].children[0];
  return match (resolvedExpressionTypeName(evidence, tree, receiver)) {
    some(name) => name == expected;
    none => false;
  };
}

function resolvedExpressionTargetName(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): Option<String> {
  const resolutionIndex = resolvedExpressionResolutionIndex(
    evidence,
    tree,
    index
  );
  if (resolutionIndex >= evidence.expressionResolutions.length) {
    return Option<String>.none;
  }
  const resolution = view evidence.expressionResolutions[resolutionIndex];
  if (
    resolution.line != tree.nodes[index].line
    || resolution.column != tree.nodes[index].column
    || resolution.targetName.byteLength == 0
  ) return Option<String>.none;
  return Option.some(resolution.targetName.copyBytes(
    0,
    resolution.targetName.byteLength
  ));
}

function annotatedBindingTypeInArena(
  in arena: StatementArena,
  in name: String,
  useOffset: usize
): Option<String> {
  let resolved = "";
  let resolvedOffset: usize = 0;
  for (const statement of arena.nodes) {
    if (
      statement.kind != StatementKind.variableStatement
      || statement.name != name
      || statement.nameOffset > useOffset
      || statement.nameOffset < resolvedOffset
    ) continue;
    match (in statement.typeAnnotation) {
      some(type) => {
        resolved = type.name.copyBytes(0, type.name.byteLength);
        resolvedOffset = statement.nameOffset;
      }
      none => {}
    }
  }
  if (resolved.byteLength > 0) return Option.some(move resolved);
  return Option<String>.none;
}

function annotatedLocalBindingTypeName(
  in program: Program,
  in name: String,
  useOffset: usize
): Option<String> {
  let ownerOffset: usize = 0;
  for (const declaration of program.functions) {
    if (
      declaration.offset <= useOffset
      && declaration.offset >= ownerOffset
    ) ownerOffset = declaration.offset;
  }
  for (const aggregate of program.aggregates) {
    for (const method of aggregate.methods) {
      if (method.offset <= useOffset && method.offset >= ownerOffset) {
        ownerOffset = method.offset;
      }
    }
  }
  for (const declaration of program.functions) {
    if (declaration.offset != ownerOffset) continue;
    return annotatedBindingTypeInArena(
      declaration.body,
      name,
      useOffset
    );
  }
  for (const aggregate of program.aggregates) {
    for (const method of aggregate.methods) {
      if (method.offset != ownerOffset) continue;
      return annotatedBindingTypeInArena(method.body, name, useOffset);
    }
  }
  return Option<String>.none;
}

function loweredIntegerSourceType(
  in importedTypes: Array<LoweredImportedType>,
  in sourceType: String,
  in targetType: String
): Option<String> {
  if (sourceType == "f32" || sourceType == "f64") {
    return Option.some(sourceType.copyBytes(0, sourceType.byteLength));
  }
  if (
    (targetType == "f32" || targetType == "f64")
    && (
      sourceType == "i8"
      || sourceType == "i16"
      || sourceType == "i32"
      || sourceType == "i64"
      || sourceType == "isize"
      || sourceType == "u8"
      || sourceType == "u16"
      || sourceType == "u32"
      || sourceType == "u64"
      || sourceType == "usize"
    )
  ) return Option.some(sourceType.copyBytes(0, sourceType.byteLength));
  if (
    sourceType == "i8"
    || sourceType == "i16"
    || sourceType == "i32"
    || sourceType == "i64"
    || sourceType == "isize"
    || sourceType == "u8"
    || sourceType == "u16"
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
          if (generic.base == "Option") return name.copyBytes(
            0,
            name.byteLength
          );
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
        || name == "i64"
      ) return name;
    }
    none => {}
  }
  let candidate = "i32";
  for (const child of tree.nodes[index].children) {
    match (resolvedExpressionTypeName(evidence, tree, child)) {
      some(name) => {
        if (name == "i64") return name;
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
          if (name == "i64") return name;
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
  const qualifiedMember = qualifiedTypeMember(name);
  let importedIndex = importedTypes.length;
  while (importedIndex > 0) {
    importedIndex = importedIndex - 1;
    if (
      importedTypes[importedIndex].kind != LoweredTypeKind.enumType
      || (
        importedTypes[importedIndex].localName != name
        && importedTypes[importedIndex].targetName != name
        && (
          qualifiedMember.byteLength == 0
          || (
            importedTypes[importedIndex].localName != qualifiedMember
            && importedTypes[importedIndex].targetName != qualifiedMember
          )
        )
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
        || importedTypes[importedIndex].kind
          == LoweredTypeKind.foreignStructType
        || importedTypes[importedIndex].kind
          == LoweredTypeKind.foreignHandleType
        || importedTypes[importedIndex].kind == LoweredTypeKind.classType
        || importedTypes[importedIndex].kind
          == LoweredTypeKind.foreignObjCType
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

function importedStructIsForeign(
  in importedTypes: Array<LoweredImportedType>,
  in name: String
): boolean {
  for (const imported of importedTypes) {
    if (
      imported.kind == LoweredTypeKind.foreignStructType
      && (
        imported.localName == name
        || imported.targetName == name
      )
    ) return true;
  }
  return false;
}

function importedValueStructIndex(
  in importedTypes: Array<LoweredImportedType>,
  in name: String
): Option<usize> {
  // Prefer the authored local identity. A concrete generic value can also be
  // reachable through internal substitution aliases such as `T`; choosing
  // one of those aliases loses the contextual `Box<i32>` shape needed to
  // lower a nested inferred constructor.
  let importedIndex = importedTypes.length;
  while (importedIndex > 0) {
    importedIndex = importedIndex - 1;
    if (
      importedTypes[importedIndex].kind == LoweredTypeKind.structType
      && importedTypes[importedIndex].localName == name
    ) return Option.some(importedIndex);
  }
  // When the expected type has already been lowered to its emitted identity,
  // prefer a concrete generic source spelling over a bare substitution alias.
  importedIndex = importedTypes.length;
  while (importedIndex > 0) {
    importedIndex = importedIndex - 1;
    if (
      importedTypes[importedIndex].kind == LoweredTypeKind.structType
      && importedTypes[importedIndex].targetName == name
    ) match (genericTypeShape(importedTypes[importedIndex].localName)) {
      some(_) => return Option.some(importedIndex);
      none => {}
    }
  }
  importedIndex = importedTypes.length;
  while (importedIndex > 0) {
    importedIndex = importedIndex - 1;
    if (
      importedTypes[importedIndex].kind == LoweredTypeKind.structType
      && importedTypes[importedIndex].targetName == name
    ) return Option.some(importedIndex);
  }
  return Option<usize>.none;
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
  if (ownerName.byteLength > 0) {
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
      if (ownerName == `${aggregate.name}.constructor`) {
        match (in aggregate.constructorDeclaration) {
          some(initializer) => for (const parameter of initializer.parameters) {
            if (parameter.name != name) continue;
            return Option.some(parameter.type.name.copyBytes(
              0,
              parameter.type.name.byteLength
            ));
          }
          none => {}
        }
      }
      for (const method of aggregate.methods) {
        if (!semanticMethodOwnerMatches(
          ownerName,
          aggregate.name,
          method.name
        )) continue;
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
  } else {
    let scopedOwnerFound = false;
    let scopedOwnerOffset: usize = 0;
    let scopedParameterType = "";
    for (const declaration of program.functions) {
      if (
        declaration.offset > useOffset
        || (
          scopedOwnerFound
          && declaration.offset < scopedOwnerOffset
        )
      ) continue;
      scopedOwnerFound = true;
      scopedOwnerOffset = declaration.offset;
      scopedParameterType = "";
      for (const parameter of declaration.parameters) {
        if (parameter.name == name) {
          scopedParameterType = parameter.type.name.copyBytes(
            0,
            parameter.type.name.byteLength
          );
        }
      }
    }
    for (const aggregate of program.aggregates) {
      match (in aggregate.constructorDeclaration) {
        some(initializer) => {
          if (
            initializer.offset <= useOffset
            && (
              !scopedOwnerFound
              || initializer.offset >= scopedOwnerOffset
            )
          ) {
            scopedOwnerFound = true;
            scopedOwnerOffset = initializer.offset;
            scopedParameterType = "";
            for (const parameter of initializer.parameters) {
              if (parameter.name == name) {
                scopedParameterType = parameter.type.name.copyBytes(
                  0,
                  parameter.type.name.byteLength
                );
              }
            }
          }
        }
        none => {}
      }
      for (const method of aggregate.methods) {
        if (
          method.offset > useOffset
          || (
            scopedOwnerFound
            && method.offset < scopedOwnerOffset
          )
        ) continue;
        scopedOwnerFound = true;
        scopedOwnerOffset = method.offset;
        scopedParameterType = "";
        for (const parameter of method.parameters) {
          if (parameter.name == name) {
            scopedParameterType = parameter.type.name.copyBytes(
              0,
              parameter.type.name.byteLength
            );
          }
        }
      }
    }
    if (scopedParameterType.byteLength > 0) {
      return Option.some(move scopedParameterType);
    }
  }
  match (annotatedLocalBindingTypeName(program, name, useOffset)) {
    some(typeName) => return Option.some(move typeName);
    none => {}
  }
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
      if (field.name == fieldName && !field.classProperty) {
        return Option.some(loweredTypeIdentity(field.type));
      }
    }
  }
  return Option<String>.none;
}

function objectiveCClassPropertyGetterForOwner(
  in importedTypes: Array<LoweredImportedType>,
  in ownerTypeName: String,
  in fieldName: String
): Option<String> {
  for (const imported of importedTypes) {
    if (
      imported.kind != LoweredTypeKind.foreignObjCType
      || (
        imported.localName != ownerTypeName
        && imported.targetName != ownerTypeName
      )
    ) continue;
    for (const field of imported.fields) {
      if (
        field.classProperty
        && field.name == fieldName
        && field.objectiveCGetter.byteLength > 0
      ) return Option.some(field.objectiveCGetter.copyBytes(
        0,
        field.objectiveCGetter.byteLength
      ));
    }
  }
  return Option<String>.none;
}

function objectiveCNativeTypeNameForOwner(
  in importedTypes: Array<LoweredImportedType>,
  in ownerTypeName: String
): Option<String> {
  for (const imported of importedTypes) {
    if (
      imported.kind == LoweredTypeKind.foreignObjCType
      && (
        imported.localName == ownerTypeName
        || imported.targetName == ownerTypeName
      )
      && imported.nativeTypeName.byteLength > 0
    ) return Option.some(imported.nativeTypeName.copyBytes(
      0,
      imported.nativeTypeName.byteLength
    ));
  }
  return Option<String>.none;
}

function objectiveCGetterForOwner(
  in importedTypes: Array<LoweredImportedType>,
  in ownerTypeName: String,
  in fieldName: String
): Option<String> {
  for (const imported of importedTypes) {
    if (
      imported.kind != LoweredTypeKind.foreignObjCType
      || (
        imported.localName != ownerTypeName
        && imported.targetName != ownerTypeName
      )
    ) continue;
    for (const field of imported.fields) {
      if (
        field.name == fieldName
        && field.objectiveCGetter.byteLength > 0
      ) return Option.some(field.objectiveCGetter.copyBytes(
        0,
        field.objectiveCGetter.byteLength
      ));
    }
  }
  return Option<String>.none;
}

function objectiveCSetterForOwner(
  in importedTypes: Array<LoweredImportedType>,
  in ownerTypeName: String,
  in fieldName: String
): Option<String> {
  for (const imported of importedTypes) {
    if (
      imported.kind != LoweredTypeKind.foreignObjCType
      || (
        imported.localName != ownerTypeName
        && imported.targetName != ownerTypeName
      )
    ) continue;
    for (const field of imported.fields) {
      if (
        field.name == fieldName
        && field.objectiveCSetter.byteLength > 0
      ) return Option.some(field.objectiveCSetter.copyBytes(
        0,
        field.objectiveCSetter.byteLength
      ));
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

function reorderClassConstructionFields(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in ownerName: String,
  inout children: Array<usize>,
  inout labels: Array<String>
): void throws String {
  let orderedChildren = Array<usize>();
  let orderedLabels = Array<String>();
  let foundOwner = false;
  for (const aggregate of program.aggregates) {
    if (aggregate.name != ownerName) continue;
    foundOwner = true;
    for (const declaredField of aggregate.fields) {
      let source: usize = 0;
      while (source < labels.length) {
        if (labels[source] == declaredField.name) {
          orderedChildren.push(children[source]);
          orderedLabels.push(labels[source].copyBytes(
            0,
            labels[source].byteLength
          ));
          break;
        }
        source = source + 1;
      }
    }
    break;
  }
  if (!foundOwner) {
    for (const imported of importedTypes) {
      if (
        imported.localName != ownerName
        && imported.targetName != ownerName
      ) continue;
      foundOwner = true;
      for (const declaredField of imported.fields) {
        let source: usize = 0;
        while (source < labels.length) {
          if (labels[source] == declaredField.name) {
            orderedChildren.push(children[source]);
            orderedLabels.push(labels[source].copyBytes(
              0,
              labels[source].byteLength
            ));
            break;
          }
          source = source + 1;
        }
      }
      break;
    }
  }
  if (!foundOwner) return;
  if (orderedChildren.length != children.length) {
    throw `native class construction could not order every ${ownerName} field`;
  }
  children = move orderedChildren;
  labels = move orderedLabels;
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
  if (tree.nodes[index].kind == ExpressionKind.callExpression) {
    const resolutionIndex = resolvedCallResolutionIndex(
      evidence,
      tree,
      index
    );
    if (resolutionIndex < evidence.callResolutions.length) {
      const resolution = view evidence.callResolutions[resolutionIndex];
      if (resolution.returnType.byteLength > 0) return Option.some(
        resolution.returnType.copyBytes(
        0,
        resolution.returnType.byteLength
      ));
    }
  }
  if (tree.nodes[index].kind == ExpressionKind.newExpression) {
    return Option.some(tree.nodes[index].value.copyBytes(
      0,
      tree.nodes[index].value.byteLength
    ));
  }
  if (
    tree.nodes[index].kind == ExpressionKind.callExpression
    && tree.nodes[index].children.length == 2
  ) {
    const callee = tree.nodes[index].children[0];
    if (
      tree.nodes[callee].kind == ExpressionKind.memberExpression
      && tree.nodes[callee].value == "from"
      && tree.nodes[callee].children.length == 1
    ) {
      const receiver = tree.nodes[callee].children[0];
      if (
        tree.nodes[receiver].kind == ExpressionKind.identifierExpression
        && tree.nodes[receiver].value == "String"
      ) return Option.some("String");
    }
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
    && tree.nodes[index].children.length == 3
  ) {
    const callee = tree.nodes[index].children[0];
    if (
      tree.nodes[callee].kind == ExpressionKind.memberExpression
      && tree.nodes[callee].value == "schedule"
      && tree.nodes[callee].children.length == 1
    ) {
      const receiver = tree.nodes[callee].children[0];
      match (staticallyResolvedExpressionTypeName(
        program,
        importedTypes,
        evidence,
        arena,
        ownerName,
        tree,
        receiver
      )) {
        some(receiverType) => {
          if (receiverType == "TaskScope") {
            return Option.some("TaskControl");
          }
        }
        none => {}
      }
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
    const resolutionIndex = resolvedCallResolutionIndex(
      evidence,
      tree,
      attempted
    );
    if (resolutionIndex < evidence.callResolutions.length) {
      const resolution = view evidence.callResolutions[resolutionIndex];
      if (resolution.errorType.byteLength > 0) return Option.some(
        `Result<${resolution.returnType}, ${resolution.errorType}>`
      );
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
                  match (fixedArrayShape(iterableType)) {
                    some(shape) => return Option.some(shape.elementType.copyBytes(
                      0,
                      shape.elementType.byteLength
                    ));
                    none => {}
                  }
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
  if (tree.nodes[index].kind == ExpressionKind.callExpression) {
    match (resolvedCallReturnTypeName(evidence, tree, index)) {
      some(returnType) => return Option.some(move returnType);
      none => {}
    }
  }
  if (
    tree.nodes[index].kind == ExpressionKind.arrayExpression
    && tree.nodes[index].children.length > 0
  ) {
    const first = tree.nodes[index].children[0];
    match (evidenceResolvedExpressionTypeName(
      program,
      importedTypes,
      evidence,
      tree,
      first
    )) {
      some(elementType) => return Option.some(
        `${elementType}[${tree.nodes[index].children.length}]`
      );
      none => {}
    }
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
  const genericFunctionSuffix = try resolvedGenericFunctionSuffix(
    program,
    importedTypes,
    evidence,
    tree,
    index
  );
  target = `${target}${genericFunctionSuffix}`;
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
  const parameterTypes = resolvedCallParameterTypes(
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
    ) {
      if (parameterTypes.length >= argument) {
        value = try wrapOwnedStorage(
          program,
          importedTypes,
          tree,
          argumentInput,
          parameterTypes[argument - 1],
          value,
          inout output
        );
      } else value = wrapImplicitOwnedTransfer(
        tree,
        argumentInput,
        value,
        inout output
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
    labels
  );
}

function lowerExpressionUsingNumericPeerType(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize,
  in peerType: Option<String>,
  inout output: Array<LoweredExpression>
): usize throws String {
  if (tree.nodes[index].kind == ExpressionKind.numberExpression) {
    match (in peerType) {
      some(expected) => return try lowerExpressionExpected(
        program,
        importedTypes,
        evidence,
        tree,
        index,
        expected,
        inout output
      );
      none => {}
    }
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

function lowerAsyncMethodTailCall(
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
  ) throw "native async method tail lowering requires a call";
  const calleeInput = tree.nodes[index].children[0];
  if (
    resolvedCallKind(evidence, tree, index) != "method"
    || tree.nodes[calleeInput].kind != ExpressionKind.memberExpression
    || tree.nodes[calleeInput].children.length != 1
  ) throw "native async method tail lowering requires an instance method";
  let sourceMethodName = tree.nodes[calleeInput].value.copyBytes(
    0,
    tree.nodes[calleeInput].value.byteLength
  );
  match (genericTypeShape(sourceMethodName)) {
    some(generic) => sourceMethodName = generic.base.copyBytes(
      0,
      generic.base.byteLength
    );
    none => {}
  }
  const genericMethodSuffix = try resolvedGenericMethodSuffix(
    program,
    importedTypes,
    evidence,
    tree,
    index
  );
  const receiverInput = tree.nodes[calleeInput].children[0];
  const receiverTypeName = match (evidenceResolvedExpressionTypeName(
    program,
    importedTypes,
    evidence,
    tree,
    receiverInput
  )) {
    some(name) => name;
    none => throw "native async method tail lowering could not resolve its receiver type";
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
    throw `native async method tail lowering requires a concrete struct or class receiver, found ${receiverTypeName}`;
  }
  const receiverMode = resolvedCallReceiverMode(evidence, tree, index);
  const borrowedClassReceiver = receiverType.kind
      == LoweredTypeKind.classType
    && receiverMode != "move"
    && receiverMode != "inout";
  const consumingStructReceiver = receiverType.kind
      == LoweredTypeKind.structType
    && receiverMode == "move";
  if (!borrowedClassReceiver && !consumingStructReceiver) {
    throw "native first-tier suspending methods require a non-consuming class receiver or a consuming struct receiver";
  }
  let receiver = try lowerExpression(
    program,
    importedTypes,
    evidence,
    tree,
    receiverInput,
    inout output
  );
  if (
    consumingStructReceiver
    && moduleTypeNeedsCleanup(program, importedTypes, receiverType)
  ) receiver = pushExpression(
    inout output,
    LoweredExpressionKind.moveValue,
    "",
    Array<usize>(receiver),
    Array<String>()
  );
  let children = Array<usize>();
  children.push(receiver);
  const parameterModes = resolvedCallParameterModes(
    program,
    evidence,
    tree,
    index
  );
  const parameterTypes = resolvedCallParameterTypes(
    program,
    evidence,
    tree,
    index
  );
  let labels = Array<String>();
  labels.push(borrowedClassReceiver ? "class" : "struct");
  labels.push(receiverMode.byteLength > 0
    ? receiverMode.copyBytes(0, receiverMode.byteLength)
    : "in");
  labels.push(receiverType.name.copyBytes(0, receiverType.name.byteLength));
  let argument: usize = 1;
  while (argument < tree.nodes[index].children.length) {
    const argumentInput = tree.nodes[index].children[argument];
    let value: usize = 0;
    if (parameterTypes.length >= argument) {
      value = try lowerExpressionExpected(
        program,
        importedTypes,
        evidence,
        tree,
        argumentInput,
        parameterTypes[argument - 1],
        inout output
      );
    } else {
      value = try lowerExpression(
        program,
        importedTypes,
        evidence,
        tree,
        argumentInput,
        inout output
      );
    }
    if (
      parameterModes.length >= argument
      && parameterModes[argument - 1] == "value"
      && parameterTypes.length >= argument
    ) value = try wrapOwnedStorage(
      program,
      importedTypes,
      tree,
      argumentInput,
      parameterTypes[argument - 1],
      value,
      inout output
    );
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
    `Z_${receiverType.name}_${sourceMethodName}${genericMethodSuffix}`,
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
  return try lowerExpressionContextual(
    program,
    importedTypes,
    evidence,
    tree,
    index,
    "",
    inout output
  );
}

function lowerExpressionContextual(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize,
  in contextualTypeName: String,
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
    tree.nodes[index].kind == ExpressionKind.weakExpression
    && tree.nodes[index].children.length == 1
  ) {
    const targetInput: usize = tree.nodes[index].children[0];
    let targetTypeName = match (evidenceResolvedExpressionTypeName(
      program,
      importedTypes,
      evidence,
      tree,
      targetInput
    )) {
      some(name) => name;
      none => "";
    };
    if (targetTypeName.byteLength == 0) {
      match (evidenceResolvedExpressionTypeName(
        program,
        importedTypes,
        evidence,
        tree,
        index
      )) {
        some(weakTypeName) => match (genericTypeShape(weakTypeName)) {
          some(generic) => {
            if (generic.base == "Weak" && generic.arguments.length == 1) {
              targetTypeName = generic.arguments[0].copyBytes(
                0,
                generic.arguments[0].byteLength
              );
            }
          }
          none => {}
        }
        none => {}
      }
    }
    if (targetTypeName.byteLength == 0) {
      throw "native weak lowering could not resolve its class target";
    }
    const targetType = try lowerModuleTypeName(
      program,
      importedTypes,
      targetTypeName
    );
    if (targetType.kind != LoweredTypeKind.classType) {
      throw `native weak lowering expected a class, found ${targetTypeName}`;
    }
    const targetExpressionIndex: usize = try lowerExpression(
      program,
      importedTypes,
      evidence,
      tree,
      targetInput,
      inout output
    );
    let children = Array<usize>();
    children.push(targetExpressionIndex);
    return pushExpression(
      inout output,
      LoweredExpressionKind.weakValue,
      targetType.name,
      move children,
      Array<String>()
    );
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
    const callResolutionIndex = resolvedCallResolutionIndex(
      evidence,
      tree,
      callInput
    );
    if (callResolutionIndex < evidence.callResolutions.length) {
      const resolution = view evidence.callResolutions[callResolutionIndex];
      callReturnType = resolution.returnType.copyBytes(
        0,
        resolution.returnType.byteLength
      );
      callErrorType = resolution.errorType.copyBytes(
        0,
        resolution.errorType.byteLength
      );
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
      program,
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
    if (callResolutionIndex < evidence.callResolutions.length) {
      const resolution = view evidence.callResolutions[
        callResolutionIndex
      ];
      if (resolution.asynchronous && resolution.kind == "method") {
        const methodCall = try lowerAsyncMethodTailCall(
          program,
          importedTypes,
          evidence,
          tree,
          callInput,
          inout output
        );
        const callableIdentity = try moduleCallFunctionTypeIdentity(
          program,
          importedTypes,
          resolution
        );
        let placedChildren = Array<usize>();
        placedChildren.push(methodCall);
        let placedLabels = Array<String>();
        placedLabels.push("method");
        return pushExpression(
          inout output,
          LoweredExpressionKind.asyncFunctionAwait,
          callableIdentity,
          placedChildren,
          placedLabels
        );
      }
    }
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
    const lowered = try lowerExpression(
      program,
      importedTypes,
      evidence,
      tree,
      binding,
      inout output
    );
    let referencedType = "";
    const bindingName = tree.nodes[binding].value.copyBytes(
      0,
      tree.nodes[binding].value.byteLength
    );
    const bindingOffset = tree.nodes[binding].offset;
    match (namedValueTypeName(
      program,
      evidence,
      "",
      bindingName,
      bindingOffset
    )) {
      some(typeName) => referencedType = move typeName;
      none => match (evidenceResolvedExpressionTypeName(
        program,
        importedTypes,
        evidence,
        tree,
        index
      )) {
        some(typeName) => referencedType = move typeName;
        none => {}
      }
    }
    if (stringStartsWith(referencedType, "view ")) {
      if (output[lowered].labels.length > 0) {
        output[lowered].labels[0] = move referencedType;
      } else output[lowered].labels.push(move referencedType);
    }
    return lowered;
  }
  if (tree.nodes[index].kind == ExpressionKind.numberExpression) {
    let labels = Array<String>();
    match (evidenceResolvedExpressionTypeName(
      program,
      importedTypes,
      evidence,
      tree,
      index
    )) {
      some(typeName) => labels.push(move typeName);
      none => {}
    }
    return pushExpression(
      inout output,
      LoweredExpressionKind.integerValue,
      tree.nodes[index].value,
      Array<usize>(),
      move labels
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
        && typeName != "i64"
        && typeName != "u8"
        && typeName != "u64"
        && typeName != "usize"
        && typeName != "f64"
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
  if (tree.nodes[index].kind == ExpressionKind.nullExpression) {
    return pushExpression(
      inout output,
      LoweredExpressionKind.nullValue,
      "",
      Array<usize>(),
      Array<String>()
    );
  }
  if (tree.nodes[index].kind == ExpressionKind.arrayExpression) {
    const typeName = match (evidenceResolvedExpressionTypeName(
      program,
      importedTypes,
      evidence,
      tree,
      index
    )) {
      some(name) => name;
      none => throw "native fixed-array literal lowering could not resolve its type";
    };
    const shape = match (fixedArrayShape(typeName)) {
      some(value) => value;
      none => throw `native array literal resolved to unsupported type ${typeName}`;
    };
    const arrayType = try lowerModuleTypeName(
      program,
      importedTypes,
      typeName
    );
    let children = Array<usize>();
    for (const childInput of tree.nodes[index].children) {
      const child = try lowerExpressionExpected(
        program,
        importedTypes,
        evidence,
        tree,
        childInput,
        shape.elementType,
        inout output
      );
      children.push(child);
    }
    return pushExpression(
      inout output,
      LoweredExpressionKind.fixedArrayValue,
      arrayType.name,
      move children,
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
    if (classType.kind == LoweredTypeKind.taskScopeType) {
      if (tree.nodes[index].children.length != 0) {
        throw "native TaskScope construction expects no arguments";
      }
      return pushExpression(
        inout output,
        LoweredExpressionKind.taskScopeValue,
        "TaskScope",
        Array<usize>(),
        Array<String>()
      );
    }
    if (classType.kind != LoweredTypeKind.classType) {
      throw `native new lowering requires a class, found ${tree.nodes[index].value}`;
    }
    // Generic bodies retain their source spelling (for example Box<T>) in
    // the expression tree while specialization aliases resolve that spelling
    // to one concrete emitted class. Always emit through the resolved type so
    // placeholders never leak into generated C identifiers.
    className = classType.name.copyBytes(0, classType.name.byteLength);
    if (resolvedCallKind(evidence, tree, index) == "constructor") {
      const parameterModes = resolvedCallParameterModes(
        program,
        evidence,
        tree,
        index
      );
      const parameterTypes = resolvedCallParameterTypes(
        program,
        evidence,
        tree,
        index
      );
      if (
        parameterModes.length != tree.nodes[index].children.length
        || parameterTypes.length != tree.nodes[index].children.length
      ) {
        throw `native constructor lowering lost the callable shape for ${tree.nodes[index].value}`;
      }
      let children = Array<usize>();
      let labels = Array<String>();
      labels.push("constructor");
      let argument: usize = 0;
      while (argument < tree.nodes[index].children.length) {
        const argumentInput = tree.nodes[index].children[argument];
        let value = try lowerExpressionExpected(
          program,
          importedTypes,
          evidence,
          tree,
          argumentInput,
          parameterTypes[argument],
          inout output
        );
        if (parameterModes[argument] == "value") {
          value = try wrapOwnedStorage(
            program,
            importedTypes,
            tree,
            argumentInput,
            parameterTypes[argument],
            value,
            inout output
          );
        }
        children.push(value);
        labels.push(parameterModes[argument].copyBytes(
          0,
          parameterModes[argument].byteLength
        ));
        argument = argument + 1;
      }
      return pushExpression(
        inout output,
        LoweredExpressionKind.classValue,
        className,
        children,
        labels
      );
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
      value = try wrapOwnedStorage(
        program,
        importedTypes,
        tree,
        valueInput,
        fieldType,
        value,
        inout output
      );
      children.push(value);
      labels.push(fieldName);
      field = field + 1;
    }
    try reorderClassConstructionFields(
      program,
      importedTypes,
      className,
      inout children,
      inout labels
    );
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
      const operandTypeName = match (
        resolvedExpressionTypeName(evidence, tree, operandInput)
      ) {
        some(name) => name;
        none => "";
      };
      if (operandTypeName != "f32" && operandTypeName != "f64") {
        kind = LoweredExpressionKind.checkedNegateInteger;
      }
    }
    else if (tree.nodes[index].value == "move") kind = LoweredExpressionKind.moveValue;
    else if (tree.nodes[index].value == "copy") {
      const operandTypeName = match (
        evidenceResolvedExpressionTypeName(
          program,
          importedTypes,
          evidence,
          tree,
          operandInput
        )
      ) {
        some(name) => name;
        none => throw "native copy lowering could not resolve its operand type";
      };
      const operandType = try lowerModuleTypeName(
        program,
        importedTypes,
        operandTypeName
      );
      if (
        operandType.kind == LoweredTypeKind.booleanType
        || operandType.kind == LoweredTypeKind.i8Type
        || operandType.kind == LoweredTypeKind.i16Type
        || operandType.kind == LoweredTypeKind.i32Type
        || operandType.kind == LoweredTypeKind.i64Type
        || operandType.kind == LoweredTypeKind.u8Type
        || operandType.kind == LoweredTypeKind.u16Type
        || operandType.kind == LoweredTypeKind.u32Type
        || operandType.kind == LoweredTypeKind.u64Type
        || operandType.kind == LoweredTypeKind.isizeType
        || operandType.kind == LoweredTypeKind.usizeType
        || operandType.kind == LoweredTypeKind.f32Type
        || operandType.kind == LoweredTypeKind.f64Type
        || operandType.kind == LoweredTypeKind.cstringType
        || (
          operandType.kind == LoweredTypeKind.fixedArrayType
          && !moduleTypeNeedsCleanup(program, importedTypes, operandType)
        )
      ) return operand;
      if (
        operandType.kind != LoweredTypeKind.stringType
        && operandType.kind != LoweredTypeKind.arrayType
        && operandType.kind != LoweredTypeKind.fixedArrayType
        && operandType.kind != LoweredTypeKind.structType
        && operandType.kind != LoweredTypeKind.enumType
      ) {
        throw `native copy lowering does not support ${operandTypeName} yet`;
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
        && operandType.kind != LoweredTypeKind.enumType
        && operandType.kind != LoweredTypeKind.fixedArrayType
        && operandType.kind != LoweredTypeKind.arrayType
        && operandType.kind != LoweredTypeKind.sliceType
        && operandType.kind != LoweredTypeKind.stringType
      ) {
        throw `native view lowering currently supports value-struct, enum, fixed-array, Array, Slice, and String projections, found ${operandTypeName}`;
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
    let operation = tree.nodes[index].value.copyBytes(
      0,
      tree.nodes[index].value.byteLength
    );
    if (kind == LoweredExpressionKind.checkedNegateInteger) {
      operation = checkedIntegerTypeName(program, evidence, tree, index);
    } else if (kind == LoweredExpressionKind.copyValue) {
      const operandTypeName = match (
        evidenceResolvedExpressionTypeName(
          program,
          importedTypes,
          evidence,
          tree,
          operandInput
        )
      ) {
        some(name) => name;
        none => throw "native copy lowering lost its operand type";
      };
      const operandType = try lowerModuleTypeName(
        program,
        importedTypes,
        operandTypeName
      );
      operation = operandType.name.copyBytes(0, operandType.name.byteLength);
    }
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
    if (tree.nodes[index].value == "instanceof") {
      const targetSourceName = typeExpressionName(tree, rightInput);
      if (targetSourceName.byteLength == 0) {
        throw "native instanceof lowering lost its Objective-C class target";
      }
      const targetType = try lowerModuleTypeName(
        program,
        importedTypes,
        targetSourceName
      );
      if (
        targetType.kind != LoweredTypeKind.foreignObjCType
        || targetType.name == "id"
      ) {
        throw `native instanceof lowering expected an Objective-C class, found ${targetSourceName}`;
      }
      const left = try lowerExpression(
        program,
        importedTypes,
        evidence,
        tree,
        leftInput,
        inout output
      );
      let children = Array<usize>();
      children.push(left);
      return pushExpression(
        inout output,
        LoweredExpressionKind.objectiveCInstanceOf,
        targetType.name,
        children,
        Array<String>()
      );
    }
    const leftType = loweringExpressionTypeName(
      program,
      evidence,
      tree,
      leftInput
    );
    const rightType = loweringExpressionTypeName(
      program,
      evidence,
      tree,
      rightInput
    );
    const left = try lowerExpressionUsingNumericPeerType(
      program,
      importedTypes,
      evidence,
      tree,
      leftInput,
      rightType,
      inout output
    );
    const right = try lowerExpressionUsingNumericPeerType(
      program,
      importedTypes,
      evidence,
      tree,
      rightInput,
      leftType,
      inout output
    );
    let kind = LoweredExpressionKind.binaryOperation;
    let comparesString = false;
    let usesFloatingPoint = false;
    match (in leftType) {
      some(name) => {
        comparesString = name == "String" || name == "view String";
        usesFloatingPoint = name == "f32" || name == "f64";
      }
      none => {}
    }
    if (!comparesString) {
      match (in rightType) {
        some(name) => {
          comparesString = name == "String" || name == "view String";
          if (name == "f32" || name == "f64") usesFloatingPoint = true;
        }
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
    else if (tree.nodes[index].value == "+" && !usesFloatingPoint) {
      kind = LoweredExpressionKind.checkedAddInteger;
    } else if (tree.nodes[index].value == "-" && !usesFloatingPoint) {
      kind = LoweredExpressionKind.checkedSubtractInteger;
    } else if (tree.nodes[index].value == "*" && !usesFloatingPoint) {
      kind = LoweredExpressionKind.checkedMultiplyInteger;
    } else if (tree.nodes[index].value == "/" && !usesFloatingPoint) {
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
      && tree.nodes[index].value != "+"
      && tree.nodes[index].value != "-"
      && tree.nodes[index].value != "*"
      && tree.nodes[index].value != "/"
      && tree.nodes[index].value != "%"
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
    const conditionInput = tree.nodes[index].children[0];
    const condition = try lowerExpression(
      program,
      importedTypes,
      evidence,
      tree,
      conditionInput,
      inout output
    );
    children.push(condition);
    let expectedTypeName = "";
    match (resolvedExpressionTypeName(evidence, tree, index)) {
      some(name) => expectedTypeName = move name;
      none => {}
    }
    let branchIndex: usize = 1;
    while (branchIndex < tree.nodes[index].children.length) {
      const childInput = tree.nodes[index].children[branchIndex];
      let child: usize = 0;
      if (expectedTypeName.byteLength > 0) {
        child = try lowerExpressionExpected(
          program,
          importedTypes,
          evidence,
          tree,
          childInput,
          expectedTypeName,
          inout output
        );
      } else {
        child = try lowerExpression(
          program,
          importedTypes,
          evidence,
          tree,
          childInput,
          inout output
        );
      }
      children.push(child);
      branchIndex = branchIndex + 1;
    }
    return pushExpression(
      inout output,
      LoweredExpressionKind.conditionalValue,
      "",
      children,
      Array<String>()
    );
  }
  if (tree.nodes[index].kind == ExpressionKind.spawnExpression) {
    if (tree.nodes[index].children.length != 1) {
      throw "native lowering received a malformed task expression";
    }
    const taskInput = tree.nodes[index].children[0];
    if (
      tree.nodes[taskInput].kind != ExpressionKind.callExpression
      || tree.nodes[taskInput].children.length == 0
    ) throw "native callable task lowering requires a direct call";
    const callableInput = tree.nodes[taskInput].children[0];
    let callableTypeName = "";
    match (resolvedExpressionTypeName(evidence, tree, callableInput)) {
      some(name) => callableTypeName = move name;
      none => {}
    }
    if (
      callableTypeName.byteLength == 0
      && (
        tree.nodes[callableInput].kind
          == ExpressionKind.identifierExpression
        || tree.nodes[callableInput].kind
          == ExpressionKind.argumentBindingExpression
      )
    ) {
      const callableName = tree.nodes[callableInput].value.copyBytes(
        0,
        tree.nodes[callableInput].value.byteLength
      );
      match (namedValueTypeName(
        program,
        evidence,
        "",
        callableName,
        tree.nodes[callableInput].offset
      )) {
        some(name) => callableTypeName = move name;
        none => {}
      }
    }
    callableTypeName = moduleCallableAliasTarget(
      program,
      importedTypes,
      callableTypeName
    );
    const signature = match (nativeFunctionSignature(callableTypeName)) {
      some(value) => value;
      none => throw "native callable task lowering could not resolve its async function type";
    };
    if (!signature.asynchronous) {
      throw "native callable task lowering received a synchronous function type";
    }
    if (signature.errorType.byteLength > 0) {
      throw "native callable tasks do not execute typed errors yet";
    }
    if (
      tree.nodes[taskInput].children.length
        != signature.parameterTypes.length + 1
    ) throw "native callable task lowering received mismatched arguments";
    let children = Array<usize>();
    const callable = try lowerExpression(
      program,
      importedTypes,
      evidence,
      tree,
      callableInput,
      inout output
    );
    children.push(callable);
    let labels = Array<String>();
    let argument: usize = 0;
    while (argument < signature.parameterTypes.length) {
      const argumentInput = tree.nodes[taskInput].children[argument + 1];
      let value = try lowerExpressionExpected(
        program,
        importedTypes,
        evidence,
        tree,
        argumentInput,
        signature.parameterTypes[argument],
        inout output
      );
      if (signature.parameterModes[argument] == "value") {
        value = try wrapOwnedStorage(
          program,
          importedTypes,
          tree,
          argumentInput,
          signature.parameterTypes[argument],
          value,
          inout output
        );
      }
      children.push(value);
      labels.push(signature.parameterModes[argument].copyBytes(
        0,
        signature.parameterModes[argument].byteLength
      ));
      argument = argument + 1;
    }
    const callableIdentity = try moduleFunctionTypeIdentity(
      program,
      importedTypes,
      signature
    );
    return pushExpression(
      inout output,
      LoweredExpressionKind.asyncFunctionTask,
      callableIdentity,
      children,
      labels
    );
  }
  if (tree.nodes[index].kind == ExpressionKind.awaitExpression) {
    if (tree.nodes[index].children.length != 1) {
      throw "native lowering received a malformed await expression";
    }
    const taskInput = tree.nodes[index].children[0];
    if (
      tree.nodes[taskInput].kind == ExpressionKind.callExpression
      && tree.nodes[taskInput].children.length == 1
    ) {
      const joinCallee = tree.nodes[taskInput].children[0];
      if (
        tree.nodes[joinCallee].kind == ExpressionKind.memberExpression
        && tree.nodes[joinCallee].children.length == 1
        && (
          tree.nodes[joinCallee].value == "close"
          || tree.nodes[joinCallee].value == "cancel"
        )
      ) {
        const receiverInput = tree.nodes[joinCallee].children[0];
        const receiverTypeName = match (
          evidenceResolvedExpressionTypeName(
            program,
            importedTypes,
            evidence,
            tree,
            receiverInput
          )
        ) {
          some(name) => name;
          none => "";
        };
        if (receiverTypeName == "TaskScope") {
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
          labels.push(tree.nodes[joinCallee].value.copyBytes(
            0,
            tree.nodes[joinCallee].value.byteLength
          ));
          return pushExpression(
            inout output,
            LoweredExpressionKind.taskScopeClose,
            "TaskScope",
            children,
            labels
          );
        }
      }
    }
    if (
      tree.nodes[taskInput].kind == ExpressionKind.callExpression
      && tree.nodes[taskInput].children.length > 0
    ) {
      const callableInput = tree.nodes[taskInput].children[0];
      const callResolutionIndex = resolvedCallResolutionIndex(
        evidence,
        tree,
        taskInput
      );
      if (callResolutionIndex < evidence.callResolutions.length) {
        const resolution = view evidence.callResolutions[
          callResolutionIndex
        ];
        if (resolution.asynchronous && resolution.kind == "function") {
          if (
            tree.nodes[taskInput].children.length
              != resolution.parameterTypes.length + 1
          ) throw "native direct async callable await received mismatched arguments";
          const resultType = try lowerModuleTypeName(
            program,
            importedTypes,
            resolution.returnType
          );
          const callableIdentity = try moduleCallFunctionTypeIdentity(
            program,
            importedTypes,
            resolution
          );
          let target = resolution.targetName.copyBytes(
            0,
            resolution.targetName.byteLength
          );
          const genericFunctionSuffix = try resolvedGenericFunctionSuffix(
            program,
            importedTypes,
            evidence,
            tree,
            taskInput
          );
          target = `${target}${genericFunctionSuffix}`;
          let callableLabels = Array<String>();
          callableLabels.push(callableIdentity.copyBytes(
            0,
            callableIdentity.byteLength
          ));
          const callable = pushExpression(
            inout output,
            LoweredExpressionKind.directFunctionValue,
            target,
            Array<usize>(),
            callableLabels
          );
          let children = Array<usize>();
          children.push(callable);
          let labels = Array<String>();
          let argument: usize = 0;
          while (argument < resolution.parameterTypes.length) {
            const argumentInput = tree.nodes[taskInput].children[
              argument + 1
            ];
            let value = try lowerExpressionExpected(
              program,
              importedTypes,
              evidence,
              tree,
              argumentInput,
              resolution.parameterTypes[argument],
              inout output
            );
            if (resolution.parameterModes[argument] == "value") {
              value = try wrapOwnedStorage(
                program,
                importedTypes,
                tree,
                argumentInput,
                resolution.parameterTypes[argument],
                value,
                inout output
              );
            }
            children.push(value);
            labels.push(resolution.parameterModes[argument].copyBytes(
              0,
              resolution.parameterModes[argument].byteLength
            ));
            argument = argument + 1;
          }
          return pushExpression(
            inout output,
            LoweredExpressionKind.asyncFunctionAwait,
            callableIdentity,
            children,
            labels
          );
        }
        if (resolution.asynchronous && resolution.kind == "method") {
          const methodCall = try lowerAsyncMethodTailCall(
            program,
            importedTypes,
            evidence,
            tree,
            taskInput,
            inout output
          );
          const callableIdentity = try moduleCallFunctionTypeIdentity(
            program,
            importedTypes,
            resolution
          );
          let children = Array<usize>();
          children.push(methodCall);
          let labels = Array<String>();
          labels.push("method");
          return pushExpression(
            inout output,
            LoweredExpressionKind.asyncFunctionAwait,
            callableIdentity,
            children,
            labels
          );
        }
      }
      let callableTypeName = "";
      match (resolvedExpressionTypeName(evidence, tree, callableInput)) {
        some(name) => callableTypeName = move name;
        none => {}
      }
      if (
        callableTypeName.byteLength == 0
        && (
          tree.nodes[callableInput].kind
            == ExpressionKind.identifierExpression
          || tree.nodes[callableInput].kind
            == ExpressionKind.argumentBindingExpression
        )
      ) {
        const callableName = tree.nodes[callableInput].value.copyBytes(
          0,
          tree.nodes[callableInput].value.byteLength
        );
        const callableOffset = tree.nodes[callableInput].offset;
        match (namedValueTypeName(
          program,
          evidence,
          "",
          callableName,
          callableOffset
        )) {
          some(name) => callableTypeName = move name;
          none => {}
        }
      }
      callableTypeName = moduleCallableAliasTarget(
        program,
        importedTypes,
        callableTypeName
      );
      match (nativeFunctionSignature(callableTypeName)) {
        some(signature) => {
          if (signature.asynchronous) {
            if (
              tree.nodes[taskInput].children.length
                != signature.parameterTypes.length + 1
            ) throw "native direct async callable await received mismatched arguments";
            const resultType = try lowerModuleTypeName(
              program,
              importedTypes,
              signature.returnType
            );
            let children = Array<usize>();
            const callable = try lowerExpression(
              program,
              importedTypes,
              evidence,
              tree,
              callableInput,
              inout output
            );
            children.push(callable);
            let labels = Array<String>();
            let argument: usize = 0;
            while (argument < signature.parameterTypes.length) {
              const argumentInput = tree.nodes[taskInput].children[
                argument + 1
              ];
              let value = try lowerExpressionExpected(
                program,
                importedTypes,
                evidence,
                tree,
                argumentInput,
                signature.parameterTypes[argument],
                inout output
              );
              if (signature.parameterModes[argument] == "value") {
                value = try wrapOwnedStorage(
                  program,
                  importedTypes,
                  tree,
                  argumentInput,
                  signature.parameterTypes[argument],
                  value,
                  inout output
                );
              }
              children.push(value);
              labels.push(signature.parameterModes[argument].copyBytes(
                0,
                signature.parameterModes[argument].byteLength
              ));
              argument = argument + 1;
            }
            const callableIdentity = try moduleFunctionTypeIdentity(
              program,
              importedTypes,
              signature
            );
            return pushExpression(
              inout output,
              LoweredExpressionKind.asyncFunctionAwait,
              callableIdentity,
              children,
              labels
            );
          }
        }
        none => {}
      }
    }
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
    const calleeInput = tree.nodes[index].children[0];
    if (
      tree.nodes[calleeInput].kind == ExpressionKind.memberExpression
      && tree.nodes[calleeInput].children.length == 1
      && tree.nodes[calleeInput].value == "pool"
      && tree.nodes[index].children.length == 2
    ) {
      const namespace = tree.nodes[calleeInput].children[0];
      if (
        tree.nodes[namespace].kind == ExpressionKind.identifierExpression
        && isImportedStandardNamespace(
          program,
          "std/objc",
          tree.nodes[namespace].value
        )
      ) {
        const operationInput = tree.nodes[index].children[1];
        if (
          tree.nodes[operationInput].kind != ExpressionKind.closureExpression
          || tree.nodes[operationInput].labels.length < 4
          || tree.nodes[operationInput].labels[2] != "block"
          || tree.nodes[operationInput].labels[3].byteLength > 0
        ) throw "native objc.pool requires one synchronous block closure";
        let parameterCount: usize = 0;
        for (const child of tree.nodes[operationInput].children) {
          if (
            tree.nodes[child].kind
              == ExpressionKind.closureParameterExpression
          ) parameterCount = parameterCount + 1;
        }
        if (parameterCount != 0) {
          throw "native objc.pool requires a zero-argument closure";
        }
        const returnType = try lowerModuleTypeName(
          program,
          importedTypes,
          tree.nodes[operationInput].labels[0]
        );
        const errorName = tree.nodes[operationInput].labels[1].copyBytes(
          0,
          tree.nodes[operationInput].labels[1].byteLength
        );
        let resultType = LoweredType({
          kind: returnType.kind,
          name: returnType.name.copyBytes(0, returnType.name.byteLength),
        });
        if (errorName.byteLength > 0) {
          const errorType = try lowerModuleTypeName(
            program,
            importedTypes,
            errorName
          );
          resultType = LoweredType({
            kind: LoweredTypeKind.enumType,
            name: intrinsicResultName(returnType, errorType),
          });
        }
        let labels = Array<String>();
        labels.push(loweredTypeIdentity(resultType));
        labels.push(loweredTypeIdentity(returnType));
        labels.push(move errorName);
        labels.push("block");
        const pooled = pushExpression(
          inout output,
          LoweredExpressionKind.objectiveCAutoreleasePool,
          `${tree.nodes[operationInput].offset}`,
          Array<usize>(),
          labels
        );
        for (const statement of tree.nodes[operationInput].statements) {
          output[pooled].statements.push(statement);
        }
        return pooled;
      }
    }
    if (
      tree.nodes[calleeInput].kind == ExpressionKind.memberExpression
      && tree.nodes[calleeInput].children.length == 1
      && tree.nodes[calleeInput].value == "schedule"
      && tree.nodes[index].children.length == 3
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
      if (receiverTypeName == "TaskScope") {
        const receiver = try lowerExpression(
          program,
          importedTypes,
          evidence,
          tree,
          receiverInput,
          inout output
        );
        const operationInput = tree.nodes[index].children[2];
        const operationTypeName = match (
          evidenceResolvedExpressionTypeName(
            program,
            importedTypes,
            evidence,
            tree,
            operationInput
          )
        ) {
          some(name) => name;
          none => "async () => void";
        };
        const operationExpression = try lowerExpressionExpected(
          program,
          importedTypes,
          evidence,
          tree,
          operationInput,
          operationTypeName,
          inout output
        );
        if (
          output[operationExpression].kind != LoweredExpressionKind.closureValue
          && output[operationExpression].kind
            != LoweredExpressionKind.directFunctionValue
          && output[operationExpression].kind != LoweredExpressionKind.localValue
        ) throw "native TaskScope.schedule requires an async callable value";
        const operationType = try lowerModuleTypeName(
          program,
          importedTypes,
          operationTypeName
        );
        if (operationType.kind != LoweredTypeKind.functionType) {
          throw "native TaskScope.schedule lost its async callable type";
        }
        let children = Array<usize>();
        children.push(receiver);
        children.push(operationExpression);
        return pushExpression(
          inout output,
          LoweredExpressionKind.taskScopeSchedule,
          operationType.name,
          children,
          Array<String>()
        );
      }
    }
    if (
      tree.nodes[calleeInput].kind == ExpressionKind.memberExpression
      && tree.nodes[calleeInput].children.length == 1
      && tree.nodes[calleeInput].value == "requestCancel"
      && tree.nodes[index].children.length == 1
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
      if (receiverTypeName == "TaskControl") {
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
          LoweredExpressionKind.taskControlCancel,
          "TaskControl",
          children,
          Array<String>()
        );
      }
    }
    if (resolvedCallIsAsynchronous(evidence, tree, index)) {
      throw "native lowering requires an explicit supported placement for async function calls";
    }
    const adapterPlanIndex = objectiveCAdapterResolutionIndex(
      evidence,
      tree,
      index
    );
    if (adapterPlanIndex < evidence.objectiveCAdapters.length) {
      if (tree.nodes[index].children.length != 2) {
        throw "native Objective-C adapter lowering lost its controller";
      }
      const plan = view evidence.objectiveCAdapters[adapterPlanIndex];
      const ownerInput = tree.nodes[index].children[1];
      const owner = try lowerExpression(
        program,
        importedTypes,
        evidence,
        tree,
        ownerInput,
        inout output
      );
      let children = Array<usize>();
      children.push(owner);
      const helperName = objectiveCAdapterHelperName(
        plan.moduleIndex,
        plan.offset
      );
      return pushExpression(
        inout output,
        LoweredExpressionKind.objectiveCProtocolAdapter,
        helperName,
        children,
        Array<String>()
      );
    }
    const registrationPlanIndex = objectiveCRegistrationResolutionIndex(
      evidence,
      tree,
      index
    );
    if (registrationPlanIndex < evidence.objectiveCRegistrations.length) {
      const plan = view evidence.objectiveCRegistrations[
        registrationPlanIndex
      ];
      if (tree.nodes[index].children.length != 2) {
        throw "native Objective-C registration lowering lost its descriptor";
      }
      const descriptor = tree.nodes[index].children[1];
      let addCall = tree.nodes.length;
      let fieldIndex: usize = 0;
      while (fieldIndex < tree.nodes[descriptor].labels.length) {
        if (tree.nodes[descriptor].labels[fieldIndex] == "add") {
          addCall = tree.nodes[descriptor].children[fieldIndex];
        }
        fieldIndex = fieldIndex + 1;
      }
      if (
        addCall >= tree.nodes.length
        || tree.nodes[addCall].kind != ExpressionKind.callExpression
        || tree.nodes[addCall].children.length == 0
      ) throw "native Objective-C registration lowering lost its add call";
      const addCallee = tree.nodes[addCall].children[0];
      if (
        tree.nodes[addCallee].kind != ExpressionKind.memberExpression
        || tree.nodes[addCallee].children.length != 1
      ) throw "native Objective-C registration lowering lost its receiver";
      let children = Array<usize>();
      const registrationReceiverInput = tree.nodes[addCallee].children[0];
      const registrationReceiver = try lowerExpression(
        program,
        importedTypes,
        evidence,
        tree,
        registrationReceiverInput,
        inout output
      );
      children.push(registrationReceiver);
      const addParameterTypes = resolvedCallParameterTypes(
        program,
        evidence,
        tree,
        addCall
      );
      let argumentIndex: usize = 0;
      while (argumentIndex + 1 < tree.nodes[addCall].children.length) {
        const argumentInput = tree.nodes[addCall].children[argumentIndex + 1];
        let value = try lowerExpression(
          program,
          importedTypes,
          evidence,
          tree,
          argumentInput,
          inout output
        );
        if (
          argumentIndex != plan.handlerParameter
          && argumentIndex < addParameterTypes.length
          && addParameterTypes[argumentIndex] == "cstring"
        ) {
          let projectionChildren = Array<usize>();
          projectionChildren.push(value);
          value = pushExpression(
            inout output,
            LoweredExpressionKind.cstringProjection,
            "cstring",
            projectionChildren,
            Array<String>()
          );
        }
        children.push(value);
        argumentIndex = argumentIndex + 1;
      }
      const registrationHelper = objectiveCRegistrationHelperName(
        plan.moduleIndex,
        plan.offset
      );
      return pushExpression(
        inout output,
        LoweredExpressionKind.objectiveCRegistration,
        registrationHelper,
        children,
        Array<String>()
      );
    }
    if (
      tree.nodes[calleeInput].kind == ExpressionKind.memberExpression
      && tree.nodes[calleeInput].value == "upgrade"
      && tree.nodes[calleeInput].children.length == 1
      && tree.nodes[index].children.length == 1
    ) {
      const receiverInput: usize = tree.nodes[calleeInput].children[0];
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
          if (generic.base == "Weak" && generic.arguments.length == 1) {
            const targetType = try lowerModuleTypeName(
              program,
              importedTypes,
              generic.arguments[0]
            );
            if (targetType.kind != LoweredTypeKind.classType) {
              throw `native Weak<T>.upgrade lowering expected a class, found ${generic.arguments[0]}`;
            }
            const receiver: usize = try lowerExpression(
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
              LoweredExpressionKind.weakUpgrade,
              targetType.name,
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
    ) {
      const replaceBindingName = tree.nodes[calleeInput].value.copyBytes(
        0,
        tree.nodes[calleeInput].value.byteLength
      );
      if (isImportedStandardBinding(
        program,
        "std/memory",
        "replace",
        replaceBindingName
      )) {
        if (tree.nodes[index].children.length != 3) {
          throw "native replace lowering expects exactly two arguments";
        }
        const valueTypeName = match (evidenceResolvedExpressionTypeName(
          program,
          importedTypes,
          evidence,
          tree,
          index
        )) {
          some(name) => name;
          none => throw "native replace lowering could not resolve its value type";
        };
        const targetInput = tree.nodes[index].children[1];
        const replacementInput = tree.nodes[index].children[2];
        const loweredTargetIndex: usize = try lowerExpression(
          program,
          importedTypes,
          evidence,
          tree,
          targetInput,
          inout output
        );
        const loweredReplacementIndex: usize = try lowerExpressionExpected(
          program,
          importedTypes,
          evidence,
          tree,
          replacementInput,
          valueTypeName,
          inout output
        );
        const valueType = try lowerModuleTypeName(
          program,
          importedTypes,
          valueTypeName
        );
        const valueIdentity = loweredTypeIdentity(valueType);
        let replaceChildren = Array<usize>();
        replaceChildren.push(loweredTargetIndex);
        replaceChildren.push(loweredReplacementIndex);
        return pushExpression(
          inout output,
          LoweredExpressionKind.memoryReplace,
          valueIdentity,
          move replaceChildren,
          Array<String>()
        );
      }
      let arenaBindingName = tree.nodes[calleeInput].value.copyBytes(
        0,
        tree.nodes[calleeInput].value.byteLength
      );
      match (genericTypeShape(arenaBindingName)) {
        some(generic) => arenaBindingName = generic.base.copyBytes(
          0,
          generic.base.byteLength
        );
        none => {}
      }
      if (importedArenaBinding(program, arenaBindingName)) {
        let arenaChildren = Array<usize>();
        if (tree.nodes[index].children.length == 2) {
          const options = tree.nodes[index].children[1];
          if (
            tree.nodes[options].kind != ExpressionKind.objectExpression
            || tree.nodes[options].children.length != 1
            || tree.nodes[options].labels.length != 1
            || tree.nodes[options].labels[0] != "initialCapacity"
          ) throw "native Arena construction requires exactly initialCapacity";
          const capacityInput = tree.nodes[options].children[0];
          const capacity = try lowerExpressionExpected(
            program,
            importedTypes,
            evidence,
            tree,
            capacityInput,
            "usize",
            inout output
          );
          arenaChildren.push(capacity);
        } else if (tree.nodes[index].children.length != 1) {
          throw "native Arena construction expects no arguments or one options object";
        }
        return pushExpression(
          inout output,
          LoweredExpressionKind.arenaNew,
          "Arena",
          arenaChildren,
          Array<String>()
        );
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
      && tree.nodes[calleeInput].value == "add"
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
          if (receiverType.kind == LoweredTypeKind.hasherType) {
            const receiver = try lowerExpression(
              program,
              importedTypes,
              evidence,
              tree,
              receiverInput,
              inout output
            );
            const argumentInput = tree.nodes[index].children[1];
            const argumentTypeName = match (resolvedExpressionTypeName(
              evidence,
              tree,
              argumentInput
            )) {
              some(name) => name;
              none => throw "native Hasher.add lowering could not resolve its argument type";
            };
            const argumentType = try lowerModuleTypeName(
              program,
              importedTypes,
              argumentTypeName
            );
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
            if (argumentType.kind == LoweredTypeKind.structType) {
              labels.push("hashable");
            }
            const argumentIdentity = loweredTypeIdentity(argumentType);
            return pushExpression(
              inout output,
              LoweredExpressionKind.hasherAdd,
              argumentIdentity,
              children,
              move labels
            );
          }
        }
        none => {}
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
      if (importedArenaBinding(program, receiverTypeName)) {
        const receiver = try lowerExpression(
          program,
          importedTypes,
          evidence,
          tree,
          receiverInput,
          inout output
        );
        let arenaChildren = Array<usize>();
        arenaChildren.push(receiver);
        if (tree.nodes[calleeInput].value == "reset") {
          if (tree.nodes[index].children.length != 1) {
            throw "Arena.reset takes no arguments";
          }
          return pushExpression(
            inout output,
            LoweredExpressionKind.arenaReset,
            "Arena",
            arenaChildren,
            Array<String>()
          );
        }
        if (tree.nodes[calleeInput].value == "create") {
          if (tree.nodes[index].children.length != 2) {
            throw "Arena.create takes one value";
          }
          const valueInput = tree.nodes[index].children[1];
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
            none => throw "native Arena.create could not resolve its result type";
          };
          if (!stringStartsWith(resultTypeName, "view ")) {
            throw `native Arena.create expected a view result, found ${resultTypeName}`;
          }
          const valueTypeName = resultTypeName.copyBytes(
            5,
            resultTypeName.byteLength
          );
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
          arenaChildren.push(value);
          const valueIdentity = loweredTypeIdentity(valueType);
          return pushExpression(
            inout output,
            LoweredExpressionKind.arenaCreate,
            valueIdentity,
            arenaChildren,
            Array<String>()
          );
        }
      }
      match (genericTypeShape(receiverTypeName)) {
        some(generic) => {
          if (
            generic.base == "Once"
            && generic.arguments.length == 1
            && (
              tree.nodes[calleeInput].value == "initialize"
              || tree.nodes[calleeInput].value == "get"
              || tree.nodes[calleeInput].value == "state"
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
              throw "Once.get/state takes no arguments";
            }
            const onceName = intrinsicOnceName(valueType);
            if (tree.nodes[calleeInput].value == "state") {
              return pushExpression(
                inout output,
                LoweredExpressionKind.onceState,
                onceName,
                children,
                Array<String>()
              );
            }
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
              const noStatements = Array<LoweredStatement>();
              captures = try collectMutexClosureCaptures(
                program,
                importedTypes,
                evidence,
                "",
                output,
                bodyStart,
                in noStatements,
                0,
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
        tree.nodes[calleeInput].value == "i8"
        || tree.nodes[calleeInput].value == "i16"
        || tree.nodes[calleeInput].value == "i32"
        || tree.nodes[calleeInput].value == "i64"
        || tree.nodes[calleeInput].value == "isize"
        || tree.nodes[calleeInput].value == "u8"
        || tree.nodes[calleeInput].value == "u16"
        || tree.nodes[calleeInput].value == "u32"
        || tree.nodes[calleeInput].value == "u64"
        || tree.nodes[calleeInput].value == "usize"
        || tree.nodes[calleeInput].value == "f32"
        || tree.nodes[calleeInput].value == "f64"
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
        loweredIntegerSourceType(importedTypes, sourceType, targetType)
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
    if (tree.nodes[calleeInput].kind == ExpressionKind.identifierExpression) {
      match (genericTypeShape(tree.nodes[calleeInput].value)) {
        some(generic) => {
          if (generic.base == "Array" && generic.arguments.length == 1) {
            const arrayType = try lowerModuleTypeName(
              program,
              importedTypes,
              tree.nodes[calleeInput].value
            );
            if (tree.nodes[index].children.length == 1) {
              return pushExpression(
                inout output,
                LoweredExpressionKind.arrayEmpty,
                arrayType.name,
                Array<usize>(),
                Array<String>()
              );
            }
            let values = Array<usize>();
            let argumentIndex: usize = 1;
            while (argumentIndex < tree.nodes[index].children.length) {
              const argumentInput = tree.nodes[index].children[argumentIndex];
              const argument = try lowerExpression(
                program,
                importedTypes,
                evidence,
                tree,
                argumentInput,
                inout output
              );
              const storedValue = try wrapOwnedStorage(
                program,
                importedTypes,
                tree,
                argumentInput,
                generic.arguments[0],
                argument,
                inout output
              );
              values.push(storedValue);
              argumentIndex = argumentIndex + 1;
            }
            return pushExpression(
              inout output,
              LoweredExpressionKind.arrayValue,
              arrayType.name,
              move values,
              Array<String>()
            );
          }
          if (
            generic.base == "Map"
            && generic.arguments.length == 2
            && tree.nodes[index].children.length == 1
          ) {
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
          if (
            generic.base == "Set"
            && generic.arguments.length == 1
            && tree.nodes[index].children.length == 1
          ) {
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
      && tree.nodes[calleeInput].value == "freeze"
    ) {
      if (tree.nodes[index].children.length != 1) {
        throw "native collection freeze lowering requires zero arguments";
      }
      const receiverInput = tree.nodes[calleeInput].children[0];
      const receiverTypeName = match (resolvedExpressionTypeName(
        evidence,
        tree,
        receiverInput
      )) {
        some(name) => name;
        none => throw "native collection freeze could not resolve its receiver type";
      };
      const receiverType = try lowerModuleTypeName(
        program,
        importedTypes,
        receiverTypeName
      );
      if (
        receiverType.kind == LoweredTypeKind.arrayType
        || receiverType.kind == LoweredTypeKind.mapType
        || receiverType.kind == LoweredTypeKind.setType
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
          LoweredExpressionKind.moveValue,
          "",
          children,
          Array<String>()
        );
      }
    }
    if (
      tree.nodes[calleeInput].kind == ExpressionKind.memberExpression
      && tree.nodes[calleeInput].children.length == 1
      && (
        tree.nodes[calleeInput].value == "has"
        || tree.nodes[calleeInput].value == "add"
        || tree.nodes[calleeInput].value == "remove"
        || tree.nodes[calleeInput].value == "delete"
        || tree.nodes[calleeInput].value == "clear"
      )
    ) {
      const receiverInput = tree.nodes[calleeInput].children[0];
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
          if (receiverType.kind == LoweredTypeKind.setType) {
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
            if (tree.nodes[calleeInput].value != "clear") {
              const argumentInput = tree.nodes[index].children[1];
              let argument = try lowerExpression(
                program,
                importedTypes,
                evidence,
                tree,
                argumentInput,
                inout output
              );
              if (tree.nodes[calleeInput].value == "add") {
                match (evidenceResolvedExpressionTypeName(
                  program,
                  importedTypes,
                  evidence,
                  tree,
                  argumentInput
                )) {
                  some(argumentTypeName) => {
                    const argumentType = try lowerModuleTypeName(
                      program,
                      importedTypes,
                      argumentTypeName
                    );
                    argument = wrapOwnedStorageType(
                      program,
                      importedTypes,
                      tree,
                      argumentInput,
                      argumentType,
                      argument,
                      inout output
                    );
                  }
                  none => {}
                }
              }
              children.push(argument);
            }
            let kind = LoweredExpressionKind.setHas;
            if (tree.nodes[calleeInput].value == "add") {
              kind = LoweredExpressionKind.setAdd;
            } else if (tree.nodes[calleeInput].value == "remove") {
              kind = LoweredExpressionKind.setRemove;
            } else if (tree.nodes[calleeInput].value == "delete") {
              kind = LoweredExpressionKind.setDelete;
            } else if (tree.nodes[calleeInput].value == "clear") {
              kind = LoweredExpressionKind.setClear;
            }
            let labels = Array<String>();
            if (receiverView) labels.push("view");
            return pushExpression(
              inout output,
              kind,
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
      tree.nodes[calleeInput].kind == ExpressionKind.memberExpression
      && tree.nodes[calleeInput].children.length == 1
      && (
        tree.nodes[calleeInput].value == "has"
        || tree.nodes[calleeInput].value == "get"
        || tree.nodes[calleeInput].value == "set"
        || tree.nodes[calleeInput].value == "remove"
        || tree.nodes[calleeInput].value == "delete"
        || tree.nodes[calleeInput].value == "clear"
      )
    ) {
      const receiverInput = tree.nodes[calleeInput].children[0];
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
              let value = try lowerExpression(
                program,
                importedTypes,
                evidence,
                tree,
                argumentInput,
                inout output
              );
              if (tree.nodes[calleeInput].value == "set") {
                match (evidenceResolvedExpressionTypeName(
                  program,
                  importedTypes,
                  evidence,
                  tree,
                  argumentInput
                )) {
                  some(argumentTypeName) => {
                    const argumentType = try lowerModuleTypeName(
                      program,
                      importedTypes,
                      argumentTypeName
                    );
                    value = wrapOwnedStorageType(
                      program,
                      importedTypes,
                      tree,
                      argumentInput,
                      argumentType,
                      value,
                      inout output
                    );
                  }
                  none => {}
                }
              }
              children.push(value);
              argument = argument + 1;
            }
            let kind = LoweredExpressionKind.mapHas;
            if (tree.nodes[calleeInput].value == "get") {
              kind = LoweredExpressionKind.mapGet;
            } else if (tree.nodes[calleeInput].value == "set") {
              kind = LoweredExpressionKind.mapSet;
            } else if (tree.nodes[calleeInput].value == "remove") {
              kind = LoweredExpressionKind.mapRemove;
            } else if (tree.nodes[calleeInput].value == "delete") {
              kind = LoweredExpressionKind.mapDelete;
            } else if (tree.nodes[calleeInput].value == "clear") {
              kind = LoweredExpressionKind.mapClear;
            }
            let labels = Array<String>();
            if (receiverView) labels.push("view");
            return pushExpression(
              inout output,
              kind,
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
      && resolvedMemberReceiverTypeIs(
        evidence,
        tree,
        calleeInput,
        "TextBuffer"
      )
      && (
        tree.nodes[calleeInput].value == "append"
        || tree.nodes[calleeInput].value == "appendBytes"
        || tree.nodes[calleeInput].value == "appendAscii"
        || tree.nodes[calleeInput].value == "appendCodePoint"
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
      } else if (tree.nodes[calleeInput].value == "appendCodePoint") {
        kind = LoweredExpressionKind.textBufferAppendCodePoint;
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
      const enumName = typeExpressionName(tree, enumInput);
      if (enumName.byteLength > 0) {
        const intrinsicName = contextualIntrinsicTypeName(
          evidence,
          tree,
          index,
          enumName
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
                      throw `native enum payload construction for ${enumName}.${variant.name} requires one value`;
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
                    const payloadTypeName = match (
                      optionPayloadTypeName(intrinsicName)
                    ) {
                      some(name) => name;
                      none => throw `native Option lowering lost the payload type for ${intrinsicName}`;
                    };
                    payload = try wrapOwnedStorage(
                      program,
                      importedTypes,
                      tree,
                      payloadInput,
                      payloadTypeName,
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
        match (enumIndex(program, enumName)) {
          some(declarationIndex) => {
            for (const variant of program.enums[declarationIndex].variants) {
              if (variant.name == tree.nodes[calleeInput].value) {
                match (in variant.payload) {
                  some(_) => {
                    if (tree.nodes[index].children.length != 2) {
                      throw `native enum payload construction for ${enumName}.${variant.name} requires one value`;
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
                      enumName
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
          enumName
        )) {
          some(declaration) => {
            for (const variant of declaration.variants) {
              if (variant.name != tree.nodes[calleeInput].value) continue;
              match (in variant.payload) {
                some(_) => {
                  if (tree.nodes[index].children.length != 2) {
                    throw `native enum payload construction for ${enumName}.${variant.name} requires one value`;
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
    let constructorTypeName = "";
    if (tree.nodes[calleeInput].kind == ExpressionKind.identifierExpression) {
      constructorTypeName = tree.nodes[calleeInput].value.copyBytes(
        0,
        tree.nodes[calleeInput].value.byteLength
      );
    } else if (
      tree.nodes[calleeInput].kind == ExpressionKind.memberExpression
      && tree.nodes[calleeInput].children.length == 1
    ) {
      const constructorReceiver = tree.nodes[calleeInput].children[0];
      if (
        tree.nodes[constructorReceiver].kind
          == ExpressionKind.identifierExpression
      ) {
        constructorTypeName = `${tree.nodes[constructorReceiver].value}.${tree.nodes[calleeInput].value}`;
      }
    }
    if (contextualTypeName.byteLength > 0) {
      match (genericTypeShape(contextualTypeName)) {
        some(generic) => {
          if (generic.base == constructorTypeName) {
            match (importedStructTarget(importedTypes, contextualTypeName)) {
              some(_) => constructorTypeName = contextualTypeName.copyBytes(
                0,
                contextualTypeName.byteLength
              );
              none => {}
            }
          }
        }
        none => {}
      }
    }
    match (resolvedExpressionTypeName(evidence, tree, index)) {
      some(resolvedTypeName) => match (genericTypeShape(resolvedTypeName)) {
        some(_) => {
          // An empty generic marker may be constructed through a transparent
          // alias. Its authored name no longer matches the resolved generic
          // base, but semantic analysis intentionally leaves no callable
          // resolution for aggregate construction. Ordinary function calls do,
          // so only that construction-shaped case may adopt the resolved type.
          const callKind = resolvedCallKind(evidence, tree, index);
          if (callKind.byteLength == 0) match (importedStructTarget(
            importedTypes,
            resolvedTypeName
          )) {
            some(_) => constructorTypeName = resolvedTypeName.copyBytes(
              0,
              resolvedTypeName.byteLength
            );
            none => {}
          }
        }
        none => {}
      }
      none => {}
    }
    if (
      constructorTypeName.byteLength > 0
      && (
        tree.nodes[index].children.length == 1
        || tree.nodes[index].children.length == 2
      )
    ) {
      let constructionName = "";
      let localAggregate = Option<usize>.none;
      if (tree.nodes[calleeInput].kind == ExpressionKind.identifierExpression) {
        match (structIndex(program, constructorTypeName)) {
          some(aggregateIndex) => {
            if (program.aggregates[aggregateIndex].typeParameters.length == 0) {
              localAggregate = Option.some(aggregateIndex);
            }
          }
          none => {}
        }
      }
      match (importedStructTarget(
        importedTypes,
        constructorTypeName
      )) {
        some(name) => constructionName = move name;
        none => match (in localAggregate) {
          some(_) => {
            constructionName = constructorTypeName.copyBytes(
              0,
              constructorTypeName.byteLength
            );
          }
          none => {}
        }
      }
      if (constructionName.byteLength == 0) {
        const resolvedConstruction = attempt lowerModuleTypeName(
          program,
          importedTypes,
          constructorTypeName
        );
        match (resolvedConstruction) {
          success(type) => {
            if (
              type.kind == LoweredTypeKind.structType
              || type.kind == LoweredTypeKind.classType
            ) constructionName = type.name.copyBytes(
              0,
              type.name.byteLength
            );
          }
          failure(_) => {}
        }
      }
      let localConstruction = false;
      match (in localAggregate) {
        some(_) => localConstruction = true;
        none => {}
      }
      let importedValueConstruction = false;
      if (
        constructionName.byteLength > 0
        && !localConstruction
        && tree.nodes[index].children.length == 1
      ) {
        match (importedValueStructIndex(importedTypes, constructionName)) {
          some(_) => importedValueConstruction = true;
          none => {}
        }
      }
      if (
        constructionName.byteLength > 0
        && (
          tree.nodes[index].children.length == 2
          || localConstruction
          || importedValueConstruction
        )
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
              none => match (importedValueStructIndex(
                importedTypes,
                constructionName
              )) {
                some(_) => {}
                none => throw "native struct-spread lowering requires a Z value struct";
              }
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
                const fieldOutcome = attempt lowerExpressionExpected(
                  program,
                  importedTypes,
                  evidence,
                  tree,
                  valueInput,
                  expectedTypeName,
                  inout output
                );
                const fieldValue = match (fieldOutcome) {
                  success(lowered) => lowered;
                  failure(message) => throw
                    `${message} for field ${constructionName}.${fieldName} expected ${expectedTypeName}`;
                };
                value = fieldValue;
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
            if (expectedTypeName.byteLength > 0) {
              const storedOutcome = attempt wrapOwnedStorage(
                program,
                importedTypes,
                tree,
                valueInput,
                expectedTypeName,
                value,
                inout output
              );
              const storedValue = match (storedOutcome) {
                success(stored) => stored;
                failure(message) => throw
                  `${message} for field ${constructionName}.${fieldName} expected ${expectedTypeName}`;
              };
              value = storedValue;
            } else {
              value = wrapImplicitOwnedTransfer(
                tree,
                valueInput,
                value,
                inout output
              );
            }
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
            let moveSpreadOverrides = Array<LoweredField>();
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
                    moveSpreadOverrides.push(LoweredField({
                      name: field.name.copyBytes(0, field.name.byteLength),
                      type: move overriddenType,
                      optionalField: field.optionalField,
                      borrowedView: false,
                      defaultTarget: "",
                    }));
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
                  if (moduleTypeNeedsCleanup(
                    program,
                    importedTypes,
                    fieldType
                  ) && loweredTypeSupportsCopyHelper(fieldType)) {
                    let copyChildren = Array<usize>();
                    copyChildren.push(value);
                    value = pushExpression(
                      inout output,
                      LoweredExpressionKind.copyValue,
                      fieldType.name,
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
            if (hasSpread && spreadMode == "move") {
              let moveChildren = Array<usize>();
              moveChildren.push(spreadSource);
              const movedSource = pushExpression(
                inout output,
                LoweredExpressionKind.moveValue,
                "",
                moveChildren,
                Array<String>()
              );
              const constructed = pushExpression(
                inout output,
                LoweredExpressionKind.structValue,
                constructionName,
                children,
                labels
              );
              let spreadChildren = Array<usize>();
              spreadChildren.push(constructed);
              spreadChildren.push(movedSource);
              const spread = pushExpression(
                inout output,
                LoweredExpressionKind.moveStructSpreadValue,
                constructionName,
                move spreadChildren,
                Array<String>()
              );
              output[spread].moveSpreadOverrides = move moveSpreadOverrides;
              return spread;
            }
          }
          none => {}
        }
        if (hasSpread && !localConstruction) {
          match (importedValueStructIndex(
            importedTypes,
            constructionName
          )) {
            some(importedIndex) => {
              let moveSpreadOverrides = Array<LoweredField>();
              for (const field of importedTypes[importedIndex].fields) {
                if (containsString(labels, field.name)) {
                  if (
                    spreadMode == "move"
                    && moduleTypeNeedsCleanup(
                      program,
                      importedTypes,
                      field.type
                    )
                  ) {
                    moveSpreadOverrides.push(LoweredField({
                      name: field.name.copyBytes(0, field.name.byteLength),
                      type: LoweredType({
                        kind: field.type.kind,
                        name: field.type.name.copyBytes(
                          0,
                          field.type.name.byteLength
                        ),
                      }),
                      optionalField: field.optionalField,
                      borrowedView: field.borrowedView,
                      defaultTarget: "",
                    }));
                  }
                  continue;
                }
                let fieldChildren = Array<usize>();
                fieldChildren.push(spreadSource);
                let value = pushExpression(
                  inout output,
                  LoweredExpressionKind.fieldValue,
                  field.name,
                  fieldChildren,
                  Array<String>()
                );
                if (spreadMode == "copy") {
                  if (moduleTypeNeedsCleanup(
                    program,
                    importedTypes,
                    field.type
                  ) && loweredTypeSupportsCopyHelper(field.type)) {
                    let copyChildren = Array<usize>();
                    copyChildren.push(value);
                    value = pushExpression(
                      inout output,
                      LoweredExpressionKind.copyValue,
                      field.type.name,
                      copyChildren,
                      Array<String>()
                    );
                  } else if (moduleTypeNeedsCleanup(
                    program,
                    importedTypes,
                    field.type
                  )) {
                    const fieldTypeName = loweredTypeIdentity(field.type);
                    throw `native copy struct-spread lowering does not support field "${field.name}" of type ${fieldTypeName} yet`;
                  }
                } else if (
                  spreadMode.byteLength == 0
                  && moduleTypeNeedsCleanup(
                    program,
                    importedTypes,
                    field.type
                  )
                ) {
                  throw `native plain struct-spread lowering cannot retain ownership-bearing field "${field.name}"`;
                }
                children.push(value);
                labels.push(field.name.copyBytes(0, field.name.byteLength));
              }
              if (spreadMode == "move") {
                let moveChildren = Array<usize>();
                moveChildren.push(spreadSource);
                const movedSource = pushExpression(
                  inout output,
                  LoweredExpressionKind.moveValue,
                  "",
                  moveChildren,
                  Array<String>()
                );
                const constructed = pushExpression(
                  inout output,
                  LoweredExpressionKind.structValue,
                  constructionName,
                  children,
                  labels
                );
                let spreadChildren = Array<usize>();
                spreadChildren.push(constructed);
                spreadChildren.push(movedSource);
                const spread = pushExpression(
                  inout output,
                  LoweredExpressionKind.moveStructSpreadValue,
                  constructionName,
                  move spreadChildren,
                  Array<String>()
                );
                output[spread].moveSpreadOverrides = move moveSpreadOverrides;
                return spread;
              }
            }
            none => {}
          }
        }
        if (!localConstruction && !hasSpread) {
          for (const imported of importedTypes) {
            if (
              imported.localName != constructionName
              && imported.targetName != constructionName
            ) continue;
            for (const field of imported.fields) {
              if (containsString(labels, field.name)) continue;
              let value: usize = 0;
              if (field.defaultTarget.byteLength > 0) {
                const callee = pushExpression(
                  inout output,
                  LoweredExpressionKind.localValue,
                  field.defaultTarget,
                  Array<usize>(),
                  Array<String>()
                );
                let callChildren = Array<usize>();
                callChildren.push(callee);
                value = pushExpression(
                  inout output,
                  LoweredExpressionKind.directCall,
                  "",
                  move callChildren,
                  Array<String>()
                );
              } else if (field.optionalField) {
                const optionalTypeName = loweredTypeIdentity(field.type);
                value = try lowerOptionalFieldNone(
                  program,
                  importedTypes,
                  optionalTypeName,
                  inout output
                );
              } else continue;
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
          importedStructIsForeign(importedTypes, constructionName)
            ? LoweredExpressionKind.foreignStructValue
            : LoweredExpressionKind.structValue,
          constructionName,
          children,
          labels
        );
      }
    }
    let staticMethodTarget = "";
    let sourceMethodName = tree.nodes[calleeInput].value.copyBytes(
      0,
      tree.nodes[calleeInput].value.byteLength
    );
    match (genericTypeShape(sourceMethodName)) {
      some(generic) => sourceMethodName = generic.base.copyBytes(
        0,
        generic.base.byteLength
      );
      none => {}
    }
    const genericMethodSuffix = try resolvedGenericMethodSuffix(
      program,
      importedTypes,
      evidence,
      tree,
      index
    );
    const staticMethodOwner = try resolvedStaticMethodOwnerType(
      program,
      importedTypes,
      evidence,
      tree,
      index
    );
    match (staticMethodOwner) {
      some(ownerType) => {
        if (
          ownerType.kind != LoweredTypeKind.structType
          && ownerType.kind != LoweredTypeKind.classType
          && ownerType.kind != LoweredTypeKind.foreignObjCType
        ) throw "native static-method lowering requires a concrete struct or class owner";
        if (ownerType.kind != LoweredTypeKind.foreignObjCType) {
          const target = `Z_${ownerType.name}_${sourceMethodName}${genericMethodSuffix}`;
          staticMethodTarget = move target;
        }
      }
      none => {}
    }
    const objectiveCSelector = resolvedObjectiveCSelector(
      evidence,
      tree,
      index
    );
    const callKind = resolvedCallKind(evidence, tree, index);
    if (
      callKind == "objectiveCDataCopy"
      || callKind == "objectiveCDataBorrow"
    ) {
      if (tree.nodes[index].children.length != 2) {
        throw "native NSData bridge lowering received a malformed call";
      }
      const parameterTypes = resolvedCallParameterTypes(
        program,
        evidence,
        tree,
        index
      );
      if (parameterTypes.length != 1) {
        throw "native NSData bridge lowering lost its byte parameter";
      }
      let children = Array<usize>();
      const argumentInput = tree.nodes[index].children[1];
      const bytes = try lowerExpressionExpected(
        program,
        importedTypes,
        evidence,
        tree,
        argumentInput,
        parameterTypes[0],
        inout output
      );
      children.push(bytes);
      return pushExpression(
        inout output,
        callKind == "objectiveCDataCopy"
          ? LoweredExpressionKind.objectiveCDataCopy
          : LoweredExpressionKind.objectiveCDataBorrow,
        "",
        move children,
        Array<String>()
      );
    }
    if (
      objectiveCSelector.byteLength > 0
      && (callKind == "method" || callKind == "staticMethod")
      && tree.nodes[calleeInput].kind == ExpressionKind.memberExpression
      && tree.nodes[calleeInput].children.length == 1
    ) {
      let children = Array<usize>();
      let labels = Array<String>();
      if (callKind == "staticMethod") {
        const receiverNativeType = resolvedObjectiveCReceiverNativeType(
          evidence,
          tree,
          index
        );
        if (receiverNativeType.byteLength == 0) {
          throw "native Objective-C lowering lost its class receiver";
        }
        children.push(pushExpression(
          inout output,
          LoweredExpressionKind.localValue,
          receiverNativeType,
          Array<usize>(),
          Array<String>()
        ));
        labels.push("class");
      } else {
        const receiverInput = tree.nodes[calleeInput].children[0];
        const receiver = try lowerExpression(
          program,
          importedTypes,
          evidence,
          tree,
          receiverInput,
          inout output
        );
        children.push(receiver);
        labels.push("instance");
      }
      const parameterModes = resolvedCallParameterModes(
        program,
        evidence,
        tree,
        index
      );
      const parameterTypes = resolvedCallParameterTypes(
        program,
        evidence,
        tree,
        index
      );
      const parameterNativeTypes = resolvedObjectiveCParameterNativeTypes(
        evidence,
        tree,
        index
      );
      let argument: usize = 1;
      while (argument < tree.nodes[index].children.length) {
        const argumentInput = tree.nodes[index].children[argument];
        let value: usize = 0;
        if (parameterTypes.length >= argument) {
          value = try lowerExpressionExpected(
            program,
            importedTypes,
            evidence,
            tree,
            argumentInput,
            parameterTypes[argument - 1],
            inout output
          );
        } else {
          value = try lowerExpression(
            program,
            importedTypes,
            evidence,
            tree,
            argumentInput,
            inout output
          );
        }
        if (
          parameterTypes.length >= argument
          && parameterNativeTypes.length >= argument
          && nativeTypeIsObjectiveCBlock(
            parameterNativeTypes[argument - 1]
          )
        ) {
          const parameterType = try lowerModuleTypeName(
            program,
            importedTypes,
            parameterTypes[argument - 1]
          );
          if (parameterType.kind != LoweredTypeKind.functionType) {
            throw "native Objective-C block lowering lost its callable type";
          }
          output[value].objectiveCBlockNativeType =
            parameterNativeTypes[argument - 1].copyBytes(
              0,
              parameterNativeTypes[argument - 1].byteLength
            );
        }
        if (
          parameterModes.length >= argument
          && parameterModes[argument - 1] == "value"
        ) {
          if (parameterTypes.length >= argument) {
            value = try wrapOwnedStorage(
              program,
              importedTypes,
              tree,
              argumentInput,
              parameterTypes[argument - 1],
              value,
              inout output
            );
          } else {
            value = wrapImplicitOwnedTransfer(
              tree,
              argumentInput,
              value,
              inout output
            );
          }
        }
        if (
          parameterModes.length >= argument
          && (
            parameterModes[argument - 1] == "inout"
            || parameterModes[argument - 1] == "out"
          )
        ) markMutableStorage(inout output, value);
        if (
          parameterTypes.length >= argument
          && parameterTypes[argument - 1] == "cstring"
        ) {
          let requiresProjection = output[value].kind
            == LoweredExpressionKind.stringValue
            || tree.nodes[argumentInput].kind
              == ExpressionKind.stringExpression
            || tree.nodes[argumentInput].kind
              == ExpressionKind.templateExpression;
          match (evidenceResolvedExpressionTypeName(
            program,
            importedTypes,
            evidence,
            tree,
            argumentInput
          )) {
            some(argumentType) => {
              if (argumentType == "String") requiresProjection = true;
            }
            none => {}
          }
          if (requiresProjection) {
            let projectionChildren = Array<usize>();
            projectionChildren.push(value);
            value = pushExpression(
              inout output,
              LoweredExpressionKind.cstringProjection,
              "cstring",
              projectionChildren,
              Array<String>()
            );
          }
        }
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
        LoweredExpressionKind.objectiveCMessageCall,
        objectiveCSelector,
        children,
        labels
      );
    }
    let inferredNominalMethod = false;
    if (
      tree.nodes[calleeInput].kind == ExpressionKind.memberExpression
      && tree.nodes[calleeInput].children.length == 1
    ) {
      const inferredReceiverInput = tree.nodes[calleeInput].children[0];
      match (evidenceResolvedExpressionTypeName(
        program,
        importedTypes,
        evidence,
        tree,
        inferredReceiverInput
      )) {
        some(inferredReceiverName) => {
          const inferredReceiver = attempt lowerModuleTypeName(
            program,
            importedTypes,
            inferredReceiverName
          );
          match (inferredReceiver) {
            success(type) => {
              if (
                type.kind == LoweredTypeKind.structType
                || type.kind == LoweredTypeKind.classType
              ) {
                match (fieldTypeNameForOwner(
                  program,
                  importedTypes,
                  inferredReceiverName,
                  tree.nodes[calleeInput].value
                )) {
                  some(_) => {}
                  none => inferredNominalMethod = true;
                }
              }
            }
            failure(_) => {}
          }
        }
        none => {}
      }
    }
    if (
      (callKind == "method" || inferredNominalMethod)
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
      let receiver = try lowerExpression(
        program,
        importedTypes,
        evidence,
        tree,
        receiverInput,
        inout output
      );
      if (
        receiverMode == "move"
        && moduleTypeNeedsCleanup(program, importedTypes, receiverType)
      ) {
        receiver = pushExpression(
          inout output,
          LoweredExpressionKind.moveValue,
          "",
          Array<usize>(receiver),
          Array<String>()
        );
      }
      let children = Array<usize>();
      children.push(receiver);
      const parameterModes = resolvedCallParameterModes(
        program,
        evidence,
        tree,
        index
      );
      const parameterTypes = resolvedCallParameterTypes(
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
        let value: usize = 0;
        if (
          parameterTypes.length >= argument
          && tree.nodes[argumentInput].kind
            == ExpressionKind.closureExpression
        ) value = try lowerExpressionExpected(
          program,
          importedTypes,
          evidence,
          tree,
          argumentInput,
          parameterTypes[argument - 1],
          inout output
        );
        else value = try lowerExpression(
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
          if (parameterTypes.length >= argument) {
            value = try wrapOwnedStorage(
              program,
              importedTypes,
              tree,
              argumentInput,
              parameterTypes[argument - 1],
              value,
              inout output
            );
          } else {
            value = wrapImplicitOwnedTransfer(
              tree,
              argumentInput,
              value,
              inout output
            );
          }
        }
        if (
          parameterModes.length >= argument
          && (
            parameterModes[argument - 1] == "inout"
            || parameterModes[argument - 1] == "out"
          )
        ) markMutableStorage(inout output, value);
        children.push(value);
        let argumentMode = parameterModes.length >= argument
          ? parameterModes[argument - 1].copyBytes(
            0,
            parameterModes[argument - 1].byteLength
          )
          : "value";
        if (
          argumentMode == "in"
          && parameterTypes.length >= argument
        ) {
          const parameterType = try lowerModuleTypeName(
            program,
            importedTypes,
            parameterTypes[argument - 1]
          );
          if (parameterType.kind == LoweredTypeKind.foreignObjCType) {
            argumentMode = "foreignObjCIn";
          }
        }
        if (
          argumentMode == "in"
          && output[value].labels.length > 0
          && stringStartsWith(output[value].labels[0], "view ")
        ) argumentMode = "view";
        labels.push(move argumentMode);
        argument = argument + 1;
      }
      return pushExpression(
        inout output,
        LoweredExpressionKind.methodCall,
        `Z_${receiverType.name}_${sourceMethodName}${genericMethodSuffix}`,
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
          || target == "math.trunc.f32"
          || target == "math.trunc.f64"
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
    if (
      standardTarget.byteLength == 0
      && tree.nodes[calleeInput].kind == ExpressionKind.memberExpression
      && tree.nodes[calleeInput].value == "from"
      && tree.nodes[calleeInput].children.length == 1
    ) {
      const stringOwner = tree.nodes[calleeInput].children[0];
      if (
        tree.nodes[stringOwner].kind == ExpressionKind.identifierExpression
        && tree.nodes[stringOwner].value == "String"
      ) standardTarget = "String.from";
    }
    match (resolvedForeignCallTarget(evidence, tree, index)) {
      some(target) => foreignTarget = move target;
      none => {}
    }
    if (staticMethodTarget.byteLength > 0) {
      callee = pushExpression(
        inout output,
        LoweredExpressionKind.localValue,
        staticMethodTarget,
        Array<usize>(),
        Array<String>()
      );
    } else if (standardTarget.byteLength > 0) {
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
      tree.nodes[calleeInput].kind == ExpressionKind.memberExpression
    ) {
      const genericFunctionSuffix = try resolvedGenericFunctionSuffix(
        program,
        importedTypes,
        evidence,
        tree,
        index
      );
      match (resolvedCallTarget(evidence, tree, index)) {
        some(target) => callee = pushExpression(
          inout output,
          LoweredExpressionKind.localValue,
          `${target}${genericFunctionSuffix}`,
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
    } else if (
      tree.nodes[calleeInput].kind == ExpressionKind.identifierExpression
    ) {
      const genericFunctionSuffix = try resolvedGenericFunctionSuffix(
        program,
        importedTypes,
        evidence,
        tree,
        index
      );
      match (resolvedCallTarget(evidence, tree, index)) {
        some(target) => callee = pushExpression(
          inout output,
          LoweredExpressionKind.localValue,
          `${target}${genericFunctionSuffix}`,
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
    const parameterTypes = resolvedCallParameterTypes(
      program,
      evidence,
      tree,
      index
    );
    let callLabels = Array<String>();
    for (const mode of parameterModes) {
      callLabels.push(mode.copyBytes(0, mode.byteLength));
    }
    let parameterLabel: usize = 0;
    while (
      parameterLabel < parameterTypes.length
      && parameterLabel < callLabels.length
    ) {
      if (callLabels[parameterLabel] == "in") {
        const parameterType = try lowerModuleTypeName(
          program,
          importedTypes,
          parameterTypes[parameterLabel]
        );
        if (parameterType.kind == LoweredTypeKind.foreignObjCType) {
          callLabels[parameterLabel] = "foreignObjCIn";
        }
      }
      parameterLabel = parameterLabel + 1;
    }
    let children = Array<usize>();
    children.push(callee);
    let argument: usize = 1;
    while (argument < tree.nodes[index].children.length) {
      const argumentInput = tree.nodes[index].children[argument];
      let value: usize = 0;
      if (
        parameterTypes.length >= argument
        && tree.nodes[argumentInput].kind
          == ExpressionKind.closureExpression
      ) value = try lowerExpressionExpected(
        program,
        importedTypes,
        evidence,
        tree,
        argumentInput,
        parameterTypes[argument - 1],
        inout output
      );
      else if (
        tree.nodes[argumentInput].kind
          == ExpressionKind.closureExpression
      ) match (evidenceResolvedExpressionTypeName(
        program,
        importedTypes,
        evidence,
        tree,
        argumentInput
      )) {
        some(expectedType) => value = try lowerExpressionExpected(
          program,
          importedTypes,
          evidence,
          tree,
          argumentInput,
          expectedType,
          inout output
        );
        none => value = try lowerExpression(
          program,
          importedTypes,
          evidence,
          tree,
          argumentInput,
          inout output
        );
      }
      else value = try lowerExpression(
        program,
        importedTypes,
        evidence,
        tree,
        argumentInput,
        inout output
      );
      if (parameterTypes.length >= argument) {
        const expectedTypeName = parameterTypes[argument - 1].copyBytes(
          0,
          parameterTypes[argument - 1].byteLength
        );
        match (genericTypeShape(expectedTypeName)) {
          some(expected) => {
            if (
              expected.base == "Slice"
              && expected.arguments.length == 1
            ) {
              match (evidenceResolvedExpressionTypeName(
                program,
                importedTypes,
                evidence,
                tree,
                argumentInput
              )) {
                some(actualTypeName) => {
                  let actualStorageTypeName = actualTypeName.copyBytes(
                    0,
                    actualTypeName.byteLength
                  );
                  let alreadyViewed = false;
                  if (
                    stringStartsWith(actualStorageTypeName, "view ")
                    && actualStorageTypeName.byteLength > 5
                  ) {
                    alreadyViewed = true;
                    actualStorageTypeName = actualStorageTypeName.copyBytes(
                      5,
                      actualStorageTypeName.byteLength
                    );
                  }
                  match (genericTypeShape(actualStorageTypeName)) {
                    some(actual) => {
                      let matchingElements = false;
                      if (
                        actual.base == "Array"
                        && actual.arguments.length == 1
                      ) {
                        const actualElement = try lowerModuleTypeName(
                          program,
                          importedTypes,
                          actual.arguments[0]
                        );
                        const expectedElement = try lowerModuleTypeName(
                          program,
                          importedTypes,
                          expected.arguments[0]
                        );
                        matchingElements = loweredTypeIdentity(actualElement)
                          == loweredTypeIdentity(expectedElement);
                      }
                      if (
                        actual.base == "Array"
                        && actual.arguments.length == 1
                        && matchingElements
                      ) {
                        const arrayType = try lowerModuleTypeName(
                          program,
                          importedTypes,
                          actualStorageTypeName
                        );
                        let source = value;
                        if (!alreadyViewed) {
                          let viewChildren = Array<usize>();
                          viewChildren.push(value);
                          source = pushExpression(
                            inout output,
                            LoweredExpressionKind.viewProjection,
                            arrayType.name,
                            move viewChildren,
                            Array<String>()
                          );
                        }
                        const zero = pushExpression(
                          inout output,
                          LoweredExpressionKind.integerValue,
                          "0",
                          Array<usize>(),
                          Array<String>()
                        );
                        let sliceChildren = Array<usize>();
                        sliceChildren.push(source);
                        sliceChildren.push(zero);
                        value = pushExpression(
                          inout output,
                          LoweredExpressionKind.arraySlice,
                          arrayType.name,
                          move sliceChildren,
                          Array<String>()
                        );
                      }
                    }
                    none => {}
                  }
                  if (
                    actualStorageTypeName == "embed.StaticBytes"
                    && expected.arguments[0] == "u8"
                  ) {
                    const sliceType = try lowerModuleTypeName(
                      program,
                      importedTypes,
                      expectedTypeName
                    );
                    let sliceChildren = Array<usize>();
                    sliceChildren.push(value);
                    value = pushExpression(
                      inout output,
                      LoweredExpressionKind.staticBytesSlice,
                      sliceType.name,
                      move sliceChildren,
                      Array<String>()
                    );
                  }
                  match (fixedArrayShape(actualStorageTypeName)) {
                    some(actual) => {
                      const actualElement = try lowerModuleTypeName(
                        program,
                        importedTypes,
                        actual.elementType
                      );
                      const expectedElement = try lowerModuleTypeName(
                        program,
                        importedTypes,
                        expected.arguments[0]
                      );
                      if (
                        loweredTypeIdentity(actualElement)
                          == loweredTypeIdentity(expectedElement)
                      ) {
                        const arrayType = try lowerModuleTypeName(
                          program,
                          importedTypes,
                          actualStorageTypeName
                        );
                        let source = value;
                        if (!alreadyViewed) {
                          let viewChildren = Array<usize>();
                          viewChildren.push(value);
                          source = pushExpression(
                            inout output,
                            LoweredExpressionKind.viewProjection,
                            arrayType.name,
                            move viewChildren,
                            Array<String>()
                          );
                        }
                        const zero = pushExpression(
                          inout output,
                          LoweredExpressionKind.integerValue,
                          "0",
                          Array<usize>(),
                          Array<String>()
                        );
                        let sliceChildren = Array<usize>();
                        sliceChildren.push(source);
                        sliceChildren.push(zero);
                        value = pushExpression(
                          inout output,
                          LoweredExpressionKind.arraySlice,
                          arrayType.name,
                          move sliceChildren,
                          Array<String>()
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
          none => {}
        }
      }
      if (
        parameterModes.length >= argument
        && parameterModes[argument - 1] == "value"
      ) {
        if (parameterTypes.length >= argument) {
          value = try wrapOwnedStorage(
            program,
            importedTypes,
            tree,
            argumentInput,
            parameterTypes[argument - 1],
            value,
            inout output
          );
        } else {
          value = wrapImplicitOwnedTransfer(
            tree,
            argumentInput,
            value,
            inout output
          );
        }
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
        parameterModes.length >= argument
        && parameterModes[argument - 1] == "in"
        && (
          output[value].kind == LoweredExpressionKind.arrayEmpty
          || output[value].kind == LoweredExpressionKind.arrayValue
        )
      ) {
        let temporaryChildren = Array<usize>();
        temporaryChildren.push(value);
        const temporaryType = output[value].value.copyBytes(
          0,
          output[value].value.byteLength
        );
        value = pushExpression(
          inout output,
          LoweredExpressionKind.borrowedTemporary,
          temporaryType,
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
        if (
          callLabels[argument - 1] == "in"
          && output[value].labels.length > 0
          && stringStartsWith(output[value].labels[0], "view ")
        ) callLabels[argument - 1] = "view";
      }
      if (
        foreignTarget.byteLength > 0
        && parameterTypes.length >= argument
        && parameterTypes[argument - 1] == "cstring"
      ) {
        let requiresProjection = output[value].kind
          == LoweredExpressionKind.stringValue
          || tree.nodes[argumentInput].kind
            == ExpressionKind.stringExpression
          || tree.nodes[argumentInput].kind
            == ExpressionKind.templateExpression;
        match (evidenceResolvedExpressionTypeName(
          program,
          importedTypes,
          evidence,
          tree,
          argumentInput
        )) {
          some(argumentType) => {
            if (argumentType == "String") requiresProjection = true;
          }
          none => {}
        }
        if (requiresProjection) {
          let projectionChildren = Array<usize>();
          projectionChildren.push(value);
          value = pushExpression(
            inout output,
            LoweredExpressionKind.cstringProjection,
            "cstring",
            projectionChildren,
            Array<String>()
          );
        }
        callLabels[argument - 1] = "value";
      }
      children.push(value);
      argument = argument + 1;
    }
    const foreignArguments = resolvedForeignArguments(
      evidence,
      tree,
      index
    );
    if (foreignArguments.length > 0) {
      let nativeChildren = Array<usize>();
      let nativeLabels = Array<String>();
      nativeChildren.push(children[0]);
      for (const nativeArgument of foreignArguments) {
        if (nativeArgument.kind == "fixed") {
          nativeChildren.push(pushExpression(
            inout output,
            LoweredExpressionKind.localValue,
            nativeArgument.value,
            Array<usize>(),
            Array<String>()
          ));
          nativeLabels.push("value");
          continue;
        }
        if (nativeArgument.source + 1 >= children.length) {
          throw "native foreign argument plan references a missing source argument";
        }
        if (
          nativeArgument.kind == "callbackAdapter"
          || nativeArgument.kind == "callbackContext"
          || nativeArgument.kind == "callbackRelease"
          || nativeArgument.kind == "callbackDirect"
        ) {
          const callbackType = try lowerModuleTypeName(
            program,
            importedTypes,
            nativeArgument.value
          );
          let callbackChildren = Array<usize>();
          if (
            nativeArgument.kind == "callbackContext"
            || nativeArgument.kind == "callbackDirect"
          ) callbackChildren.push(
            children[nativeArgument.source + 1]
          );
          let callbackLabels = Array<String>();
          callbackLabels.push(nativeArgument.kind.copyBytes(
            0,
            nativeArgument.kind.byteLength
          ));
          callbackLabels.push(nativeArgument.mode.copyBytes(
            0,
            nativeArgument.mode.byteLength
          ));
          callbackLabels.push(nativeArgument.thread.copyBytes(
            0,
            nativeArgument.thread.byteLength
          ));
          nativeChildren.push(pushExpression(
            inout output,
            LoweredExpressionKind.foreignCallbackValue,
            callbackType.name,
            callbackChildren,
            callbackLabels
          ));
          nativeLabels.push("value");
          continue;
        }
        nativeChildren.push(children[nativeArgument.source + 1]);
        nativeLabels.push(nativeArgument.mode.copyBytes(
          0,
          nativeArgument.mode.byteLength
        ));
      }
      children = move nativeChildren;
      callLabels = move nativeLabels;
    }
    let callableCalleeType = "";
    match (resolvedExpressionTypeName(evidence, tree, calleeInput)) {
      some(typeName) => callableCalleeType = move typeName;
      none => {}
    }
    if (
      callableCalleeType.byteLength == 0
      && output[callee].labels.length > 0
    ) callableCalleeType = output[callee].labels[0].copyBytes(
      0,
      output[callee].labels[0].byteLength
    );
    let callableBinding = calleeInput;
    if (
      tree.nodes[callableBinding].kind
        == ExpressionKind.argumentReferenceExpression
      && tree.nodes[callableBinding].children.length == 1
    ) callableBinding = tree.nodes[callableBinding].children[0];
    if (
      tree.nodes[callableBinding].kind
        == ExpressionKind.identifierExpression
      || tree.nodes[callableBinding].kind
        == ExpressionKind.argumentBindingExpression
    ) {
      const bindingName = tree.nodes[callableBinding].value.copyBytes(
        0,
        tree.nodes[callableBinding].value.byteLength
      );
      const bindingOffset = tree.nodes[callableBinding].offset;
      match (namedValueTypeName(
        program,
        evidence,
        "",
        bindingName,
        bindingOffset
      )) {
        some(typeName) => callableCalleeType = move typeName;
        none => {}
      }
    }
    if (
      tree.nodes[callableBinding].kind == ExpressionKind.memberExpression
      && tree.nodes[callableBinding].children.length == 1
    ) {
      const receiver = tree.nodes[callableBinding].children[0];
      match (evidenceResolvedExpressionTypeName(
        program,
        importedTypes,
        evidence,
        tree,
        receiver
      )) {
        some(ownerTypeName) => match (fieldTypeNameForOwner(
          program,
          importedTypes,
          ownerTypeName,
          tree.nodes[callableBinding].value
        )) {
          some(typeName) => callableCalleeType = move typeName;
          none => {}
        }
        none => {}
      }
    }
    callableCalleeType = moduleCallableAliasTarget(
      program,
      importedTypes,
      callableCalleeType
    );
    if (
      standardTarget.byteLength == 0
      && foreignTarget.byteLength == 0
    ) {
      if (stringStartsWith(callableCalleeType, "Function_")) {
        return pushExpression(
          inout output,
          LoweredExpressionKind.functionCall,
          callableCalleeType,
          children,
          callLabels
        );
      }
      match (nativeFunctionSignature(callableCalleeType)) {
        some(signature) => {
          const callableIdentity = try moduleFunctionTypeIdentity(
            program,
            importedTypes,
            signature
          );
          let callableLabels = Array<String>();
          for (const mode of signature.parameterModes) {
            callableLabels.push(mode.copyBytes(0, mode.byteLength));
          }
          return pushExpression(
            inout output,
            LoweredExpressionKind.functionCall,
            callableIdentity,
            children,
            callableLabels
          );
        }
        none => {}
      }
    }
    let resultMode = "";
    if (foreignTarget.byteLength > 0) {
      match (evidenceResolvedExpressionTypeName(
        program,
        importedTypes,
        evidence,
        tree,
        index
      )) {
        some(resultType) => {
          if (
            resultType == "cstring"
            || resultType == "view cstring"
            || resultType == "view cstring | null"
          ) resultMode = "foreignCString";
        }
        none => {}
      }
    }
    return pushExpression(
      inout output,
      LoweredExpressionKind.directCall,
      resultMode,
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
    if (
      receiverType.kind != LoweredTypeKind.arrayType
      && receiverType.kind != LoweredTypeKind.sliceType
      && receiverType.kind != LoweredTypeKind.fixedArrayType
      && receiverType.kind != LoweredTypeKind.staticBytesType
    ) {
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
      receiverType.kind == LoweredTypeKind.staticBytesType
        ? LoweredExpressionKind.staticBytesIndex
        : LoweredExpressionKind.arrayIndex,
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
    const classOwnerTypeName = typeExpressionName(tree, receiverInput);
    if (classOwnerTypeName.byteLength > 0) {
      match (objectiveCClassPropertyGetterForOwner(
        importedTypes,
        classOwnerTypeName,
        tree.nodes[index].value
      )) {
        some(getter) => {
          const nativeOwner = match (objectiveCNativeTypeNameForOwner(
            importedTypes,
            classOwnerTypeName
          )) {
            some(name) => name;
            none => throw "native Objective-C class property lowering lost its class receiver";
          };
          let propertyChildren = Array<usize>();
          propertyChildren.push(pushExpression(
            inout output,
            LoweredExpressionKind.localValue,
            nativeOwner,
            Array<usize>(),
            Array<String>()
          ));
          let propertyLabels = Array<String>();
          propertyLabels.push("class");
          return pushExpression(
            inout output,
            LoweredExpressionKind.objectiveCMessageCall,
            getter,
            propertyChildren,
            propertyLabels
          );
        }
        none => {}
      }
    }
    match (evidenceResolvedExpressionTypeName(
      program,
      importedTypes,
      evidence,
      tree,
      receiverInput
    )) {
      some(receiverTypeName) => {
        if (
          receiverTypeName == "TaskControl"
          && (
            tree.nodes[index].value == "accepted"
            || tree.nodes[index].value == "isCancellationRequested"
          )
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
          let labels = Array<String>();
          labels.push("class");
          const propertyName = tree.nodes[index].value == "accepted"
            ? "accepted"
            : "cancellation_requested";
          return pushExpression(
            inout output,
            LoweredExpressionKind.fieldValue,
            propertyName,
            children,
            labels
          );
        }
      }
      none => {}
    }
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
      match (objectiveCGetterForOwner(
        importedTypes,
        payloadTypeName,
        tree.nodes[index].value
      )) {
        some(_) => throw "native optional Objective-C property access remains deferred";
        none => {}
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
    match (evidenceResolvedExpressionTypeName(
      program,
      importedTypes,
      evidence,
      tree,
      receiverInput
    )) {
      some(receiverTypeName) => match (objectiveCGetterForOwner(
        importedTypes,
        receiverTypeName,
        tree.nodes[index].value
      )) {
        some(getter) => {
          const receiver = try lowerExpression(
            program,
            importedTypes,
            evidence,
            tree,
            receiverInput,
            inout output
          );
          let propertyChildren = Array<usize>();
          propertyChildren.push(receiver);
          let propertyLabels = Array<String>();
          propertyLabels.push("instance");
          return pushExpression(
            inout output,
            LoweredExpressionKind.objectiveCMessageCall,
            getter,
            propertyChildren,
            propertyLabels
          );
        }
        none => {}
      }
      none => {}
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
          if (receiverType.kind == LoweredTypeKind.fixedArrayType) {
            const shape = match (fixedArrayShape(receiverValueTypeName)) {
              some(value) => value;
              none => throw "native fixed-array length lowering lost its source shape";
            };
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
              LoweredExpressionKind.fixedArrayLength,
              shape.length,
              move children,
              Array<String>()
            );
          }
          if (
            receiverType.kind == LoweredTypeKind.arrayType
            || receiverType.kind == LoweredTypeKind.sliceType
            || receiverType.kind == LoweredTypeKind.staticBytesType
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
          if (
            receiverType.kind == LoweredTypeKind.mapType
            || receiverType.kind == LoweredTypeKind.setType
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
            let labels = Array<String>();
            if (receiverView) labels.push("view");
            return pushExpression(
              inout output,
              receiverType.kind == LoweredTypeKind.mapType
                ? LoweredExpressionKind.mapLength
                : LoweredExpressionKind.setLength,
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
      // Some synthesized async trees do not retain receiver evidence here.
      // Keep their established String lowering, but never shadow a resolved
      // aggregate field that happens to use the same name.
      let stringProperty = true;
      match (evidenceResolvedExpressionTypeName(
        program,
        importedTypes,
        evidence,
        tree,
        receiverInput
      )) {
        some(receiverTypeName) => {
          let receiverValueTypeName = receiverTypeName.copyBytes(
            0,
            receiverTypeName.byteLength
          );
          if (stringStartsWith(receiverValueTypeName, "view ")) {
            labels.push("view");
            receiverValueTypeName = receiverValueTypeName.copyBytes(
              5,
              receiverValueTypeName.byteLength
            );
          }
          stringProperty = receiverValueTypeName == "String"
            || receiverValueTypeName == "TextBuffer";
        }
        none => {}
      }
      if (stringProperty) {
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
    }
    if (tree.nodes[receiverInput].kind == ExpressionKind.identifierExpression) {
      const intrinsicName = contextualIntrinsicTypeName(
        evidence,
        tree,
        index,
        tree.nodes[receiverInput].value
      );
      const intrinsic = try intrinsicEnumDeclaration(
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
    match (resolvedExpressionTypeName(evidence, tree, index)) {
      some(resultType) => {
        if (
          stringStartsWith(resultType, "view ")
          && !stringStartsWith(resultType, "view cstring")
        ) {
          labels.push("resultView");
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

function moduleCallableAliasTarget(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in name: String
): String {
  let target = name.copyBytes(0, name.byteLength);
  let depth: usize = 0;
  while (depth < 64) {
    let next = Option<String>.none;
    match (localTypeAliasTarget(program, target)) {
      some(value) => next = Option.some(move value);
      none => {
        for (const imported of importedTypes) {
          if (
            imported.localName == target
            && imported.kind == LoweredTypeKind.functionType
            && imported.underlyingType.byteLength > 0
          ) {
            next = Option.some(imported.underlyingType.copyBytes(
              0,
              imported.underlyingType.byteLength
            ));
          }
        }
      }
    }
    match (next) {
      some(value) => target = move value;
      none => break;
    }
    depth = depth + 1;
  }
  return target;
}

struct ModuleCallableAliasTargets {
  targets: Array<String>;
  indices: Map<String, usize>;
}

function appendModuleCallableAliasTarget(
  inout aliases: ModuleCallableAliasTargets,
  in name: String,
  in target: String
): void {
  const index = aliases.targets.length;
  aliases.targets.push(target.copyBytes(0, target.byteLength));
  aliases.indices.set(name.copyBytes(0, name.byteLength), index);
}

function collectModuleCallableAliasTargets(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>
): ModuleCallableAliasTargets {
  let aliases = ModuleCallableAliasTargets({
    targets: Array<String>(),
    indices: Map<String, usize>(),
  });
  let importedIndex: usize = 0;
  while (importedIndex < importedTypes.length) {
    const imported = view importedTypes[importedIndex];
    if (
      imported.kind == LoweredTypeKind.functionType
      && imported.underlyingType.byteLength > 0
    ) {
      appendModuleCallableAliasTarget(
        inout aliases,
        imported.localName,
        imported.underlyingType
      );
    }
    importedIndex = importedIndex + 1;
  }
  // Local aliases take precedence over imported aliases, matching
  // moduleCallableAliasTarget's lookup order.
  for (const declaration of program.typeAliases) {
    appendModuleCallableAliasTarget(
      inout aliases,
      declaration.name,
      declaration.target.name
    );
  }
  return aliases;
}

function indexedModuleCallableAliasTarget(
  in aliases: ModuleCallableAliasTargets,
  in name: String
): String {
  let target = name.copyBytes(0, name.byteLength);
  let depth: usize = 0;
  while (depth < 64) {
    const index = moduleCallableAliasIndex(aliases, target);
    if (index >= aliases.targets.length) break;
    const next = view aliases.targets[index];
    target = next.copyBytes(0, next.byteLength);
    depth = depth + 1;
  }
  return target;
}

function moduleCallableAliasIndex(
  in aliases: ModuleCallableAliasTargets,
  in name: String
): usize {
  const found = aliases.indices.get(name);
  match (in found) {
    some(index) => return index;
    none => return aliases.targets.length;
  }
}

function expressionProducesZString(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): boolean {
  if (
    tree.nodes[index].kind == ExpressionKind.stringExpression
    || tree.nodes[index].kind == ExpressionKind.templateExpression
  ) return true;
  match (evidenceResolvedExpressionTypeName(
    program,
    importedTypes,
    evidence,
    tree,
    index
  )) {
    some(actualTypeName) => {
      if (actualTypeName == "String") return true;
    }
    none => {}
  }
  if (
    tree.nodes[index].kind == ExpressionKind.unaryExpression
    && tree.nodes[index].children.length == 1
  ) {
    const child = tree.nodes[index].children[0];
    return expressionProducesZString(
      program,
      importedTypes,
      evidence,
      tree,
      child
    );
  }
  return false;
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
  let expectedIsObjectiveCString = false;
  if (expectedTypeName.byteLength > 0) {
    let expectedObjectiveCTypeName = expectedTypeName.copyBytes(
      0,
      expectedTypeName.byteLength
    );
    const nullableTarget = nullableTargetType(expectedTypeName);
    if (nullableTarget.byteLength > 0) {
      expectedObjectiveCTypeName = move nullableTarget;
    }
    const expectedType = try lowerModuleTypeName(
      program,
      importedTypes,
      expectedObjectiveCTypeName
    );
    expectedIsObjectiveCString = expectedType.kind
      == LoweredTypeKind.foreignObjCType
      && expectedType.name == "NSString";
  }
  if (expectedIsObjectiveCString) {
    const sourceIsString = expressionProducesZString(
      program,
      importedTypes,
      evidence,
      tree,
      index
    );
    if (sourceIsString) {
      const value = try lowerExpression(
        program,
        importedTypes,
        evidence,
        tree,
        index,
        inout output
      );
      return pushExpression(
        inout output,
        LoweredExpressionKind.objectiveCStringFromZ,
        "",
        Array<usize>(value),
        Array<String>()
      );
    }
  }
  if (expectedTypeName == "String") {
    match (resolvedExpressionTypeName(evidence, tree, index)) {
      some(actualTypeName) => {
        const actualType = try lowerModuleTypeName(
          program,
          importedTypes,
          actualTypeName
        );
        if (
          actualType.kind == LoweredTypeKind.foreignObjCType
          && actualType.name == "NSString"
        ) {
          const value = try lowerExpression(
            program,
            importedTypes,
            evidence,
            tree,
            index,
            inout output
          );
          return pushExpression(
            inout output,
            LoweredExpressionKind.objectiveCStringToZ,
            "",
            Array<usize>(value),
            Array<String>()
          );
        }
      }
      none => {}
    }
  }
  if (
    tree.nodes[index].kind == ExpressionKind.conditionalExpression
    && tree.nodes[index].children.length == 3
  ) {
    const conditionInput = tree.nodes[index].children[0];
    const thenInput = tree.nodes[index].children[1];
    const elseInput = tree.nodes[index].children[2];
    if (
      !expressionTreeContainsTry(tree, thenInput)
      && !expressionTreeContainsTry(tree, elseInput)
    ) {
      const condition = try lowerExpression(
        program,
        importedTypes,
        evidence,
        tree,
        conditionInput,
        inout output
      );
      const thenValue = try lowerExpressionExpected(
        program,
        importedTypes,
        evidence,
        tree,
        thenInput,
        expectedTypeName,
        inout output
      );
      const elseValue = try lowerExpressionExpected(
        program,
        importedTypes,
        evidence,
        tree,
        elseInput,
        expectedTypeName,
        inout output
      );
      let children = Array<usize>();
      children.push(condition);
      children.push(thenValue);
      children.push(elseValue);
      return pushExpression(
        inout output,
        LoweredExpressionKind.conditionalValue,
        "",
        move children,
        Array<String>()
      );
    }
  }
  if (tree.nodes[index].kind == ExpressionKind.numberExpression) {
    let labels = Array<String>();
    labels.push(expectedTypeName.copyBytes(0, expectedTypeName.byteLength));
    return pushExpression(
      inout output,
      LoweredExpressionKind.integerValue,
      tree.nodes[index].value,
      Array<usize>(),
      move labels
    );
  }
  if (tree.nodes[index].kind == ExpressionKind.arrayExpression) {
    match (fixedArrayShape(expectedTypeName)) {
      some(shape) => {
        const arrayType = try lowerModuleTypeName(
          program,
          importedTypes,
          expectedTypeName
        );
        let children = Array<usize>();
        for (const childInput of tree.nodes[index].children) {
          const child = try lowerExpressionExpected(
            program,
            importedTypes,
            evidence,
            tree,
            childInput,
            shape.elementType,
            inout output
          );
          children.push(child);
        }
        return pushExpression(
          inout output,
          LoweredExpressionKind.fixedArrayValue,
          arrayType.name,
          move children,
          Array<String>()
        );
      }
      none => {}
    }
  }
  const callableTypeName = moduleCallableAliasTarget(
    program,
    importedTypes,
    expectedTypeName
  );
  match (nativeFunctionSignature(callableTypeName)) {
    some(signature) => {
      const functionTypeName = try moduleFunctionTypeIdentity(
        program,
        importedTypes,
        signature
      );
      const functionType = LoweredType({
        kind: LoweredTypeKind.functionType,
        name: functionTypeName,
      });
      if (tree.nodes[index].kind == ExpressionKind.closureExpression) {
        if (
          tree.nodes[index].labels.length < 4
          || (
            tree.nodes[index].labels[2] != "expression"
            && tree.nodes[index].labels[2] != "block"
          )
          || (
            tree.nodes[index].labels[3].byteLength > 0
            && tree.nodes[index].labels[3] != "async"
          )
        ) {
          throw "native first-class callable lowering received an unsupported closure shape";
        }
        const bodyKind = tree.nodes[index].labels[2].copyBytes(
          0,
          tree.nodes[index].labels[2].byteLength
        );
        const closureAsynchronous = tree.nodes[index].labels[3] == "async";
        if (closureAsynchronous != signature.asynchronous) {
          throw "native callable closure lost its asynchronous function-type identity";
        }
        let parameterNames = Array<String>();
        let bodyInput = tree.nodes.length;
        for (const child of tree.nodes[index].children) {
          if (
            tree.nodes[child].kind
              == ExpressionKind.closureParameterExpression
          ) parameterNames.push(tree.nodes[child].value.copyBytes(
            0,
            tree.nodes[child].value.byteLength
          ));
          else bodyInput = child;
        }
        if (parameterNames.length != signature.parameterTypes.length) {
          throw "native callable closure lost its parameter shape";
        }
        if (bodyKind == "block") {
          if (
            closureAsynchronous
            || signature.returnType != "void"
            || signature.errorType.byteLength > 0
          ) {
            throw "native block callable closures currently require a synchronous, nonthrowing void signature";
          }
          let labels = Array<String>();
          labels.push(functionType.name.copyBytes(
            0,
            functionType.name.byteLength
          ));
          labels.push(tree.nodes[index].value.copyBytes(
            0,
            tree.nodes[index].value.byteLength
          ));
          labels.push("plain");
          for (const parameterName of parameterNames) {
            labels.push(parameterName.copyBytes(
              0,
              parameterName.byteLength
            ));
          }
          const closure = pushExpression(
            inout output,
            LoweredExpressionKind.closureValue,
            "",
            Array<usize>(),
            labels
          );
          for (const statement of tree.nodes[index].statements) {
            output[closure].statements.push(statement);
          }
          output[closure].closureBlockBody = true;
          output[closure].closureParameterCount = parameterNames.length;
          for (const parameterMode of signature.parameterModes) {
            output[closure].closureParameterModes.push(
              parameterMode.copyBytes(0, parameterMode.byteLength)
            );
          }
          output[closure].threadSafe = signature.threadContract
            == "thread.any";
          return closure;
        }
        if (bodyInput >= tree.nodes.length) {
          throw "native callable closure lost its expression body";
        }
        let asyncSuspension = "";
        if (closureAsynchronous) {
          if (signature.errorType.byteLength > 0) {
            throw "native stored async closures do not execute typed errors yet";
          }
          if (expressionTreeContainsAwait(tree, bodyInput)) {
            if (
              signature.returnType == "void"
              && expressionTreeIsSchedulerYieldAwait(
                program,
                tree,
                bodyInput
              )
            ) asyncSuspension = "scheduler-yield";
            else if (
              tree.nodes[bodyInput].kind == ExpressionKind.awaitExpression
            ) asyncSuspension = "method-await";
            else {
              throw "native stored async closure suspension currently supports one direct awaited method or `await scheduler.yield()` expression";
            }
          }
        }
        const bodyStart = output.length;
        let body: usize = 0;
        if (asyncSuspension == "scheduler-yield") {
          body = pushExpression(
            inout output,
            LoweredExpressionKind.booleanValue,
            "false",
            Array<usize>(),
            Array<String>()
          );
        } else {
          body = try lowerExpressionExpected(
            program,
            importedTypes,
            evidence,
            tree,
            bodyInput,
            signature.returnType,
            inout output
          );
        }
        if (
          asyncSuspension == "method-await"
          && (
            output[body].kind != LoweredExpressionKind.asyncFunctionAwait
          )
        ) throw "native stored async closure suspension currently requires one direct async call";
        let callableParameter: usize = 0;
        while (callableParameter < parameterNames.length) {
          if (signature.parameterModes[callableParameter] != "value") {
            rewriteClosureParameterValues(
              inout output,
              bodyStart,
              parameterNames[callableParameter]
            );
          }
          callableParameter = callableParameter + 1;
        }
        let captureNames = Array<String>();
        let captureTypes = Array<LoweredType>();
        let scan = bodyStart;
        while (scan < output.length) {
          if (output[scan].kind != LoweredExpressionKind.localValue) {
            scan = scan + 1;
            continue;
          }
          const candidate = output[scan].value.copyBytes(
            0,
            output[scan].value.byteLength
          );
          let parameter = false;
          for (const parameterName of parameterNames) {
            if (parameterName == candidate) parameter = true;
          }
          let directCallee = false;
          let parent = bodyStart;
          while (parent < output.length) {
            if (
              output[parent].kind == LoweredExpressionKind.directCall
              && output[parent].children.length > 0
              && output[parent].children[0] == scan
            ) directCallee = true;
            parent = parent + 1;
          }
          let present = false;
          for (const captureName of captureNames) {
            if (captureName == candidate) present = true;
          }
          if (parameter || directCallee || present) {
            scan = scan + 1;
            continue;
          }
          const closureOffset = tree.nodes[index].offset;
          const captureTypeName = match (namedValueTypeName(
            program,
            evidence,
            "",
            candidate,
            closureOffset
          )) {
            some(name) => name;
            none => throw `native callable closure cannot resolve capture ${candidate}`;
          };
          captureNames.push(candidate.copyBytes(0, candidate.byteLength));
          const captureType = try lowerModuleTypeName(
            program,
            importedTypes,
            captureTypeName
          );
          captureTypes.push(move captureType);
          scan = scan + 1;
        }
        let children = Array<usize>();
        children.push(body);
        let capture: usize = 0;
        while (capture < captureNames.length) {
          const local = pushExpression(
            inout output,
            LoweredExpressionKind.localValue,
            captureNames[capture],
            Array<usize>(),
            Array<String>()
          );
          let stored = local;
          if (
            tree.nodes[index].value == "move"
            && moduleTypeRetainsCapturedIdentity(captureTypes[capture])
          ) {
            let retainedChildren = Array<usize>();
            retainedChildren.push(local);
            stored = pushExpression(
              inout output,
              LoweredExpressionKind.retainValue,
              captureTypes[capture].name,
              retainedChildren,
              Array<String>()
            );
          } else if (
            tree.nodes[index].value == "move"
            && moduleTypeNeedsCleanup(
              program,
              importedTypes,
              captureTypes[capture]
            )
          ) {
            let movedChildren = Array<usize>();
            movedChildren.push(local);
            stored = pushExpression(
              inout output,
              LoweredExpressionKind.moveValue,
              "",
              movedChildren,
              Array<String>()
            );
          }
          children.push(stored);
          capture = capture + 1;
        }
        let labels = Array<String>();
        labels.push(functionType.name.copyBytes(
          0,
          functionType.name.byteLength
        ));
        labels.push(tree.nodes[index].value.copyBytes(
          0,
          tree.nodes[index].value.byteLength
        ));
        labels.push(signature.errorType.byteLength > 0
          ? "throwing"
          : "plain");
        for (const parameterName of parameterNames) {
          labels.push(parameterName.copyBytes(
            0,
            parameterName.byteLength
          ));
        }
        for (const captureName of captureNames) {
          labels.push(captureName.copyBytes(0, captureName.byteLength));
        }
        const closure = pushExpression(
          inout output,
          LoweredExpressionKind.closureValue,
          asyncSuspension,
          children,
          labels
        );
        output[closure].threadSafe = signature.threadContract == "thread.any";
        for (const captureType of captureTypes) {
          output[closure].captureTypes.push(LoweredType({
            kind: captureType.kind,
            name: captureType.name.copyBytes(0, captureType.name.byteLength),
          }));
        }
        return closure;
      }
      if (
        tree.nodes[index].kind == ExpressionKind.identifierExpression
      ) {
        const bindingName = tree.nodes[index].value.copyBytes(
          0,
          tree.nodes[index].value.byteLength
        );
        const bindingOffset = tree.nodes[index].offset;
        match (namedValueTypeName(
          program,
          evidence,
          "",
          bindingName,
          bindingOffset
        )) {
          some(_) => {
            const local = try lowerExpression(
              program,
              importedTypes,
              evidence,
              tree,
              index,
              inout output
            );
            let retainedChildren = Array<usize>();
            retainedChildren.push(local);
            return pushExpression(
              inout output,
              LoweredExpressionKind.retainValue,
              functionType.name,
              retainedChildren,
              Array<String>()
            );
          }
          none => {}
        }
        let target = bindingName.copyBytes(0, bindingName.byteLength);
        match (importedCallTarget(program, target)) {
          some(imported) => target = move imported;
          none => {}
        }
        let labels = Array<String>();
        labels.push(functionType.name.copyBytes(
          0,
          functionType.name.byteLength
        ));
        return pushExpression(
          inout output,
          LoweredExpressionKind.directFunctionValue,
          target,
          Array<usize>(),
          labels
        );
      }
      if (expressionBorrowsStoredReference(tree, index)) {
        const borrowed = try lowerExpression(
          program,
          importedTypes,
          evidence,
          tree,
          index,
          inout output
        );
        let retainedChildren = Array<usize>();
        retainedChildren.push(borrowed);
        return pushExpression(
          inout output,
          LoweredExpressionKind.retainValue,
          functionType.name,
          move retainedChildren,
          Array<String>()
        );
      }
    }
    none => {}
  }
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
              && tree.nodes[callee].value == "fromNullable"
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
              return pushExpression(
                inout output,
                LoweredExpressionKind.optionFromNullable,
                declaration.name,
                children,
                Array<String>()
              );
            }
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
              if (stringStartsWith(generic.arguments[0], "view ")) {
                let payloadAlreadyView = false;
                match (evidenceResolvedExpressionTypeName(
                  program,
                  importedTypes,
                  evidence,
                  tree,
                  payloadIndex
                )) {
                  some(actualType) => payloadAlreadyView = stringStartsWith(
                    actualType,
                    "view "
                  );
                  none => {}
                }
                if (!payloadAlreadyView) {
                  let projected = Array<usize>();
                  projected.push(payload);
                  payload = pushExpression(
                    inout output,
                    LoweredExpressionKind.viewProjection,
                    generic.arguments[0],
                    projected,
                    Array<String>()
                  );
                }
              } else payload = try wrapOwnedStorage(
                  program,
                  importedTypes,
                  tree,
                  payloadIndex,
                  generic.arguments[0],
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
  let contextualTypeName = "";
  match (importedValueStructIndex(importedTypes, expectedTypeName)) {
    some(importedIndex) => {
      contextualTypeName = importedTypes[importedIndex].localName.copyBytes(
        0,
        importedTypes[importedIndex].localName.byteLength
      );
    }
    none => {}
  }
  return try lowerExpressionContextual(
    program,
    importedTypes,
    evidence,
    tree,
    index,
    contextualTypeName,
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
  if (
    tree.nodes[index].kind == ExpressionKind.unaryExpression
    && tree.nodes[index].children.length == 1
    && (
      tree.nodes[index].value == "move"
      || tree.nodes[index].value == "copy"
    )
  ) {
    const operand = tree.nodes[index].children[0];
    return isExplicitOptionExpression(
      evidence,
      tree,
      operand
    );
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
  payload = try wrapOwnedStorage(
    program,
    importedTypes,
    tree,
    index,
    payloadTypeName,
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

function lowerUnsafeSelectedExpression(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in arena: StatementArena,
  in expression: ExpressionSyntax,
  inout output: Array<LoweredExpression>
): usize throws String {
  match (in expression.tree) {
    some(tree) => {
      const root = tree.root;
      if (
        tree.nodes[root].kind != ExpressionKind.unsafeExpression
        || tree.nodes[root].statements.length != 1
      ) throw "native unsafe lowering requires exactly one selected value";
      const statementIndex = tree.nodes[root].statements[0];
      if (arena.nodes[statementIndex].kind != StatementKind.selectStatement) {
        throw "native unsafe lowering requires exactly one selected value";
      }
      return match (in arena.nodes[statementIndex].expression) {
        some(selected) => try lowerExpressionSyntax(
          program,
          importedTypes,
          evidence,
          selected,
          inout output
        );
        none => throw "native unsafe lowering requires a selected value";
      };
    }
    none => throw "native lowering cannot lower an opaque unsafe expression";
  }
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
  const intrinsicCallee = tree.nodes[index].children[0];
  if (
    tree.nodes[intrinsicCallee].kind == ExpressionKind.memberExpression
    && tree.nodes[intrinsicCallee].value == "pool"
    && tree.nodes[intrinsicCallee].children.length == 1
    && tree.nodes[index].children.length == 2
  ) {
    const namespace = tree.nodes[intrinsicCallee].children[0];
    const operation = tree.nodes[index].children[1];
    if (
      tree.nodes[namespace].kind == ExpressionKind.identifierExpression
      && isImportedStandardNamespace(
        program,
        "std/objc",
        tree.nodes[namespace].value
      )
      && tree.nodes[operation].kind == ExpressionKind.closureExpression
      && tree.nodes[operation].labels.length >= 2
      && tree.nodes[operation].labels[1].byteLength > 0
    ) {
      return try intrinsicResultDeclaration(
        program,
        importedTypes,
        `Result<${tree.nodes[operation].labels[0]}, ${tree.nodes[operation].labels[1]}>`
      );
    }
  }
  if (
    tree.nodes[intrinsicCallee].kind == ExpressionKind.memberExpression
    && tree.nodes[intrinsicCallee].value == "upgrade"
    && tree.nodes[intrinsicCallee].children.length == 1
    && tree.nodes[index].children.length == 1
  ) {
    const receiver = tree.nodes[intrinsicCallee].children[0];
    match (evidenceResolvedExpressionTypeName(
      program,
      importedTypes,
      evidence,
      tree,
      receiver
    )) {
      some(receiverTypeName) => match (genericTypeShape(receiverTypeName)) {
        some(generic) => {
          if (generic.base == "Weak" && generic.arguments.length == 1) {
            return try intrinsicResultDeclaration(
              program,
              importedTypes,
              `Result<${generic.arguments[0]}, WeakExpired>`
            );
          }
        }
        none => {}
      }
      none => {}
    }
  }
  const resolutionIndex = resolvedCallResolutionIndex(
    evidence,
    tree,
    index
  );
  if (resolutionIndex < evidence.callResolutions.length) {
    const resolution = view evidence.callResolutions[resolutionIndex];
    if (resolution.errorType.byteLength > 0) {
      const resultName =
        `Result<${resolution.returnType}, ${resolution.errorType}>`;
      return try intrinsicResultDeclaration(
        program,
        importedTypes,
        resultName
      );
    }
  }
  let callee = tree.nodes[index].children[0];
  if (
    tree.nodes[callee].kind == ExpressionKind.argumentReferenceExpression
    && tree.nodes[callee].children.length == 1
  ) callee = tree.nodes[callee].children[0];
  match (resolvedExpressionTypeName(evidence, tree, callee)) {
    some(calleeTypeName) => {
      let callableTypeName = calleeTypeName.copyBytes(
        0,
        calleeTypeName.byteLength
      );
      match (localTypeAliasTarget(program, callableTypeName)) {
        some(target) => callableTypeName = move target;
        none => {}
      }
      match (nativeFunctionSignature(callableTypeName)) {
        some(signature) => {
          if (signature.errorType.byteLength > 0) {
            const resultName = `Result<${signature.returnType}, ${signature.errorType}>`;
            return try intrinsicResultDeclaration(
              program,
              importedTypes,
              resultName
            );
          }
        }
        none => {}
      }
    }
    none => {}
  }
  if (
    tree.nodes[callee].kind == ExpressionKind.identifierExpression
    || tree.nodes[callee].kind == ExpressionKind.argumentBindingExpression
  ) {
    const calleeName = tree.nodes[callee].value.copyBytes(
      0,
      tree.nodes[callee].value.byteLength
    );
    const calleeOffset = tree.nodes[callee].offset;
    match (namedValueTypeName(
      program,
      evidence,
      ownerName,
      calleeName,
      calleeOffset
    )) {
      some(calleeTypeName) => {
        let callableTypeName = calleeTypeName.copyBytes(
          0,
          calleeTypeName.byteLength
        );
        match (localTypeAliasTarget(program, callableTypeName)) {
          some(target) => callableTypeName = move target;
          none => {}
        }
        match (nativeFunctionSignature(callableTypeName)) {
          some(signature) => {
            if (signature.errorType.byteLength > 0) {
              const resultName = `Result<${signature.returnType}, ${signature.errorType}>`;
              return try intrinsicResultDeclaration(
                program,
                importedTypes,
                resultName
              );
            }
          }
          none => {}
        }
      }
      none => {}
    }
  }
  if (
    tree.nodes[callee].kind == ExpressionKind.memberExpression
    && tree.nodes[callee].children.length == 1
  ) {
    const receiver = tree.nodes[callee].children[0];
    match (evidenceResolvedExpressionTypeName(
      program,
      importedTypes,
      evidence,
      tree,
      receiver
    )) {
      some(ownerTypeName) => match (fieldTypeNameForOwner(
        program,
        importedTypes,
        ownerTypeName,
        tree.nodes[callee].value
      )) {
        some(fieldTypeName) => {
          const callableTypeName = moduleCallableAliasTarget(
            program,
            importedTypes,
            fieldTypeName
          );
          match (nativeFunctionSignature(callableTypeName)) {
            some(signature) => {
              if (signature.errorType.byteLength > 0) {
                return try intrinsicResultDeclaration(
                  program,
                  importedTypes,
                  `Result<${signature.returnType}, ${signature.errorType}>`
                );
              }
            }
            none => {}
          }
        }
        none => {}
      }
      none => {}
    }
  }
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
    some(name) => {
      if (stringStartsWith(name, "view ")) {
        return Option.some(name.copyBytes(5, name.byteLength));
      }
      return Option.some(move name);
    }
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

function foreignUnionMatchEvidence(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  root: usize
): Option<usize> {
  let index: usize = 0;
  while (index < evidence.foreignUnionMatches.length) {
    const plan = view evidence.foreignUnionMatches[index];
    if (
      plan.offset == tree.nodes[root].offset
      && plan.line == tree.nodes[root].line
      && plan.column == tree.nodes[root].column
    ) return Option.some(index);
    index = index + 1;
  }
  return Option<usize>.none;
}

function loweredForeignUnionMatchDeclaration(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in plan: ModuleForeignUnionMatch
): LoweredEnum throws String {
  let variants = Array<LoweredVariant>();
  let payloadBearing = false;
  for (const variant of plan.variants) {
    let payload = Option<LoweredType>.none;
    if (variant.payloadType.byteLength > 0) {
      const lowered = try lowerModuleTypeName(
        program,
        importedTypes,
        variant.payloadType
      );
      payload = Option.some(move lowered);
      payloadBearing = true;
    }
    variants.push(LoweredVariant({
      name: variant.name.copyBytes(0, variant.name.byteLength),
      payload,
    }));
  }
  const unionType = try lowerModuleTypeName(
    program,
    importedTypes,
    plan.unionType
  );
  return LoweredEnum({
    name: unionType.name.copyBytes(0, unionType.name.byteLength),
    nativeCName: unionType.name.copyBytes(0, unionType.name.byteLength),
    nativeCUnderlyingType: "",
    variants,
    payloadBearing,
    needsDeinit: false,
  });
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
  in arena: StatementArena,
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
      if (tree.nodes[root].kind == ExpressionKind.matchExpression) {
        return try lowerMatchTree(
          program,
          importedTypes,
          evidence,
          arena,
          ownerName,
          tree,
          root,
          returnValue,
          valueBinding,
          inout expressions,
          inout statements
        );
      }
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
          none => try requiredThrowingFunctionResult(
            program,
            importedTypes,
            ownerName
          );
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
  let expectedTypeName = "";
  if (returnValue) {
    match (ownerReturnTypeName(program, ownerName)) {
      some(name) => expectedTypeName = move name;
      none => {}
    }
  } else if (valueBinding.byteLength > 0) {
    match (namedValueTypeName(
      program,
      evidence,
      ownerName,
      valueBinding,
      expression.offset
    )) {
      some(name) => expectedTypeName = move name;
      none => {}
    }
  }
  let value: usize = 0;
  match (in expression.tree) {
    some(tree) => {
      const root = tree.root;
      if (expectedTypeName.byteLength > 0) {
        value = try lowerExpressionExpected(
          program,
          importedTypes,
          evidence,
          tree,
          root,
          expectedTypeName,
          inout expressions
        );
      } else {
        value = try lowerExpression(
          program,
          importedTypes,
          evidence,
          tree,
          root,
          inout expressions
        );
      }
    }
    none => throw "native lowering cannot lower an opaque expression";
  }
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
  if (arena.nodes[index].kind == StatementKind.matchStatement) {
    return match (in arena.nodes[index].expression) {
      some(expression) => match (in expression.tree) {
        some(tree) => {
          const root = tree.root;
          select try lowerMatchTree(
            program,
            importedTypes,
            evidence,
            arena,
            ownerName,
            tree,
            root,
            returnValue,
            valueBinding,
            inout expressions,
            inout statements
          );
        }
        none => throw "native value-match lowering received an empty nested match";
      }
      none => throw "native value-match lowering received an empty nested match";
    };
  }
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
        arena,
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

function rewriteLoweredMatchPayloadBinding(
  inout expressions: Array<LoweredExpression>,
  in statements: Array<LoweredStatement>,
  expressionStart: usize,
  statementStart: usize,
  in sourceBinding: String,
  in emittedBinding: String
): void {
  if (
    sourceBinding.byteLength == 0
    || sourceBinding == emittedBinding
  ) return;
  let expressionIndex = expressionStart;
  while (expressionIndex < expressions.length) {
    let assignmentTarget = false;
    let statementIndex = statementStart;
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
      && expressions[expressionIndex].kind
        == LoweredExpressionKind.localValue
      && expressions[expressionIndex].value == sourceBinding
    ) {
      expressions[expressionIndex].value = emittedBinding.copyBytes(
        0,
        emittedBinding.byteLength
      );
    }
    expressionIndex = expressionIndex + 1;
  }
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
  const foreignPlan = foreignUnionMatchEvidence(evidence, tree, root);
  const declaration = match (in foreignPlan) {
    some(planIndex) => try loweredForeignUnionMatchDeclaration(
      program,
      importedTypes,
      evidence.foreignUnionMatches[planIndex]
    );
    none => try matchEnumDeclaration(
      program,
      importedTypes,
      evidence,
      arena,
      ownerName,
      tree,
      root
    );
  };
  let nicheViewOption = false;
  match (intrinsicViewOptionPayloadName(declaration.name)) {
    some(_) => nicheViewOption = true;
    none => {}
  }
  let consuming = tree.nodes[root].value != "in";
  match (in foreignPlan) {
    some(_) => consuming = false;
    none => {}
  }
  if (
    consuming
    && tree.nodes[subjectInput].kind == ExpressionKind.identifierExpression
  ) {
    const subjectName = tree.nodes[subjectInput].value.copyBytes(
      0,
      tree.nodes[subjectInput].value.byteLength
    );
    for (const functionDeclaration of program.functions) {
      if (functionDeclaration.name != ownerName) continue;
      for (const parameter of functionDeclaration.parameters) {
        if (
          parameter.name == subjectName
          && parameter.mode != ParameterMode.value
        ) consuming = false;
      }
    }
    for (const aggregate of program.aggregates) {
      for (const method of aggregate.methods) {
        if (!semanticMethodOwnerMatches(
          ownerName,
          aggregate.name,
          method.name
        )) continue;
        if (
          subjectName == "this"
          && method.receiverMode != ReceiverMode.move
        ) consuming = false;
        for (const parameter of method.parameters) {
          if (
            parameter.name == subjectName
            && parameter.mode != ParameterMode.value
          ) consuming = false;
        }
      }
    }
  }
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
    rewriteLoweredMatchPayloadBinding(
      inout expressions,
      statements,
      armExpressionStart,
      armStatementStart,
      sourcePayloadBinding,
      emittedPayloadBinding
    );
    const matchBindingNeedsCleanup = match (in payloadType) {
      some(type) => !nicheViewOption && consuming
        && moduleTypeNeedsCleanup(program, importedTypes, type)
        && !payloadTransfersOut;
      none => false;
    };
    const loweredArm = statements.length;
    let foreignMember = "";
    let foreignValues = Array<String>();
    let foreignFallback = false;
    match (in foreignPlan) {
      some(planIndex) => {
        const plan = view evidence.foreignUnionMatches[planIndex];
        for (const variant of plan.variants) {
          if (variant.name != tree.nodes[arm].value) continue;
          foreignMember = variant.member.copyBytes(
            0,
            variant.member.byteLength
          );
          for (const value of variant.values) {
            foreignValues.push(value.copyBytes(0, value.byteLength));
          }
          foreignFallback = variant.fallback;
        }
      }
      none => {}
    }
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
      foreignMatchMember: foreignMember,
      foreignMatchValues: foreignValues,
      foreignMatchFallback: foreignFallback,
    }));
    armStatements.push(loweredArm);
    armPosition = armPosition + 1;
  }
  let labels = Array<String>();
  match (in foreignPlan) {
    some(_) => {}
    none => {
      if (nicheViewOption) labels.push("niche-view-option");
      else if (declaration.payloadBearing) labels.push("tagged");
    }
  }
  match (resolvedExpressionTypeName(evidence, tree, subjectInput)) {
    some(subjectType) => {
      if (stringStartsWith(subjectType, "view ")) labels.push("view-subject");
    }
    none => {}
  }
  let matchType = LoweredType({
    kind: LoweredTypeKind.enumType,
    name: declaration.name.copyBytes(0, declaration.name.byteLength),
  });
  let foreignDiscriminant = "";
  match (in foreignPlan) {
    some(planIndex) => {
      const plan = view evidence.foreignUnionMatches[planIndex];
      matchType = try lowerModuleTypeName(
        program,
        importedTypes,
        plan.unionType
      );
      foreignDiscriminant = plan.discriminantMember.copyBytes(
        0,
        plan.discriminantMember.byteLength
      );
    }
    none => {}
  }
  const outputIndex = statements.length;
  statements.push(LoweredStatement({
    kind: LoweredStatementKind.matchStatement,
    mutableBinding: false,
    name: declaration.name.copyBytes(0, declaration.name.byteLength),
    type: Option.some(move matchType),
    expression: Option.some(subject),
    secondExpression: Option<usize>.none,
    children: armStatements,
    cleanups: Array<LoweredCleanup>(),
    liveFlag: "",
    labels,
    matchConsumesSubject: consuming,
    matchBindingNeedsCleanup: false,
    foreignMatchDiscriminant: foreignDiscriminant,
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

function isImportedStandardNamespace(
  in program: Program,
  in header: String,
  in localName: String
): boolean {
  for (const declaration of program.imports) {
    if (
      declaration.header == header
      && !declaration.selective
      && declaration.moduleName == localName
    ) return true;
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
    const resolutionIndex = resolvedCallResolutionIndex(
      evidence,
      tree,
      index
    );
    if (resolutionIndex < evidence.callResolutions.length) {
      const resolution = view evidence.callResolutions[resolutionIndex];
      if (resolution.returnType.byteLength > 0) return Option.some(
        resolution.returnType.copyBytes(
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

function rewriteObjCPoolReturns(
  in resultType: LoweredType,
  in returnType: LoweredType,
  throwing: boolean,
  start: usize,
  inout expressions: Array<LoweredExpression>,
  inout statements: Array<LoweredStatement>
): void {
  let statementIndex = start;
  while (statementIndex < statements.length) {
    if (
      statements[statementIndex].kind
        != LoweredStatementKind.returnStatement
    ) {
      statementIndex = statementIndex + 1;
      continue;
    }
    statements[statementIndex].type = Option.some(LoweredType({
      kind: resultType.kind,
      name: resultType.name.copyBytes(0, resultType.name.byteLength),
    }));
    const currentExpression = statements[statementIndex].expression;
    match (currentExpression) {
      some(existing) => {
        if (
          throwing
          && expressions[existing].kind
            == LoweredExpressionKind.enumPayloadValue
          && expressions[existing].value == resultType.name
        ) {
          statementIndex = statementIndex + 1;
          continue;
        }
        let payload = existing;
        if (
          expressions[existing].kind
            == LoweredExpressionKind.enumPayloadValue
          && expressions[existing].children.length == 1
          && expressions[existing].value != returnType.name
        ) payload = expressions[existing].children[0];
        if (throwing) {
          let children = Array<usize>();
          children.push(payload);
          let labels = Array<String>();
          labels.push(
            statements[statementIndex].labels.length > 0
              && statements[statementIndex].labels[0] == "throw"
              ? "failure"
              : "success"
          );
          const wrapped = pushExpression(
            inout expressions,
            LoweredExpressionKind.enumPayloadValue,
            resultType.name,
            move children,
            move labels
          );
          statements[statementIndex].expression = Option.some(wrapped);
        } else statements[statementIndex].expression = Option.some(payload);
      }
      none => if (throwing) {
        let labels = Array<String>();
        labels.push("success");
        labels.push("tagged");
        const wrapped = pushExpression(
          inout expressions,
          LoweredExpressionKind.enumValue,
          resultType.name,
          Array<usize>(),
          move labels
        );
        statements[statementIndex].expression = Option.some(wrapped);
      }
    }
    statementIndex = statementIndex + 1;
  }
}

function rewritePlainVoidClosureReturns(
  in roots: Array<usize>,
  inout statements: Array<LoweredStatement>
): void {
  for (const statementIndex of roots) {
    if (
      statements[statementIndex].kind
        == LoweredStatementKind.returnStatement
      && !loweredStatementHasLabel(statements[statementIndex], "throw")
    ) {
      statements[statementIndex].expression = Option<usize>.none;
      statements[statementIndex].type = Option<LoweredType>.none;
    }
    let children = Array<usize>();
    for (const child of statements[statementIndex].children) {
      children.push(child);
    }
    rewritePlainVoidClosureReturns(children, inout statements);
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
  const expressionEnd = expressions.length;
  while (expressionIndex < expressionEnd) {
    if (
      expressions[expressionIndex].kind
        == LoweredExpressionKind.closureValue
      && expressions[expressionIndex].closureBlockBody
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
      // A block callable is currently guaranteed to be synchronous,
      // nonthrowing, and void by contextual lowering above. Its `return;`
      // statements therefore return from the callable, not from an enclosing
      // throwing Z function whose Result shape happened to be used while the
      // shared statement lowerer was running.
      rewritePlainVoidClosureReturns(
        loweredStatements,
        inout statements
      );
      let parameter: usize = 0;
      while (parameter < expressions[expressionIndex].closureParameterCount) {
        const parameterName = expressions[expressionIndex].labels[
          3 + parameter
        ].copyBytes(
          0,
          expressions[expressionIndex].labels[3 + parameter].byteLength
        );
        if (
          parameter >= expressions[expressionIndex]
            .closureParameterModes.length
          || expressions[expressionIndex].closureParameterModes[parameter]
            != "value"
        ) {
          rewriteClosureParameterValues(
            inout expressions,
            bodyExpressionStart,
            parameterName
          );
        }
        parameter = parameter + 1;
      }
      const captures = try collectCallableBlockCaptures(
        program,
        importedTypes,
        evidence,
        ownerName,
        expressions,
        bodyExpressionStart,
        statements,
        bodyStatementStart,
        closureUseOffset
      );
      for (const capture of captures) {
        if (
          capture.owned
          && expressions[expressionIndex].labels[1] != "move"
        ) {
          throw `native escaping callable requires a move closure to capture ${capture.name}`;
        }
        const local = pushExpression(
          inout expressions,
          LoweredExpressionKind.localValue,
          capture.name,
          Array<usize>(),
          Array<String>()
        );
        let stored = local;
        if (
          expressions[expressionIndex].labels[1] == "move"
          && moduleTypeRetainsCapturedIdentity(capture.type)
        ) {
          let retainedChildren = Array<usize>();
          retainedChildren.push(local);
          stored = pushExpression(
            inout expressions,
            LoweredExpressionKind.retainValue,
            capture.type.name,
            retainedChildren,
            Array<String>()
          );
        } else if (
          expressions[expressionIndex].labels[1] == "move"
          && capture.owned
        ) {
          let movedChildren = Array<usize>();
          movedChildren.push(local);
          stored = pushExpression(
            inout expressions,
            LoweredExpressionKind.moveValue,
            "",
            movedChildren,
            Array<String>()
          );
        }
        expressions[expressionIndex].children.push(stored);
        expressions[expressionIndex].labels.push(capture.name.copyBytes(
          0,
          capture.name.byteLength
        ));
        expressions[expressionIndex].captureTypes.push(LoweredType({
          kind: capture.type.kind,
          name: capture.type.name.copyBytes(0, capture.type.name.byteLength),
        }));
      }
      let statementIndex = bodyStatementStart;
      while (statementIndex < statements.length) {
        match (in statements[statementIndex].type) {
          some(type) => {
            const ownsCleanupBearingLocal = (
              statements[statementIndex].kind
                == LoweredStatementKind.localStatement
              || (
                statements[statementIndex].kind
                  == LoweredStatementKind.matchArmStatement
                && statements[statementIndex].matchBindingNeedsCleanup
              )
            ) && moduleTypeNeedsCleanup(program, importedTypes, type);
            if (ownsCleanupBearingLocal) {
              throw `native block callable closures do not support cleanup-bearing local ${statements[statementIndex].name}: ${type.name} yet`;
            }
          }
          none => {}
        }
        statementIndex = statementIndex + 1;
      }
      expressions[expressionIndex].statements = move loweredStatements;
      expressionIndex = expressionIndex + 1;
      continue;
    }
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
      const workerMoveIndex = cleanupMoveIndex(
        program,
        evidence,
        arena,
        expressions
      );
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
        workerMoveIndex,
        inout statements,
        inout workerLiveFlags,
        false,
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
        == LoweredExpressionKind.objectiveCAutoreleasePool
      && expressions[expressionIndex].labels.length >= 4
      && expressions[expressionIndex].labels[3] == "block"
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
      const throwing = expressions[expressionIndex].labels[2].byteLength > 0;
      let resultType = LoweredType({
        kind: LoweredTypeKind.enumType,
        name: expressions[expressionIndex].labels[0].copyBytes(
          0,
          expressions[expressionIndex].labels[0].byteLength
        ),
      });
      if (!throwing) {
        resultType = try lowerModuleTypeName(
          program,
          importedTypes,
          expressions[expressionIndex].labels[1]
        );
      }
      const returnType = try lowerModuleTypeName(
        program,
        importedTypes,
        expressions[expressionIndex].labels[1]
      );
      rewriteObjCPoolReturns(
        resultType,
        returnType,
        throwing,
        bodyStatementStart,
        inout expressions,
        inout statements
      );
      const bodyExpressionEnd = expressions.length;
      let useOffset: usize = 0;
      if (sourceStatements.length > 0) {
        useOffset = arena.nodes[sourceStatements[0]].offset;
      }
      const captures = try collectObjCPoolClosureCaptures(
        program,
        importedTypes,
        evidence,
        ownerName,
        expressions,
        bodyExpressionStart,
        useOffset
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
      let poolLiveFlags = Array<LoweredLiveFlag>();
      const inherited = Array<LoweredCleanup>();
      const loopCleanups = Array<LoweredCleanup>();
      const poolMoveIndex = cleanupMoveIndex(
        program,
        evidence,
        arena,
        expressions
      );
      const introduced = try planCleanupSequence(
        program,
        importedTypes,
        evidence,
        arena,
        ownerName,
        sourceStatements,
        loweredStatements,
        inherited,
        expressions,
        poolMoveIndex,
        inout statements,
        inout poolLiveFlags,
        false,
        false,
        loopCleanups
      );
      attachMoveLiveFlagsRange(
        inout expressions,
        poolLiveFlags,
        bodyExpressionStart,
        bodyExpressionEnd
      );
      expressions[expressionIndex].statements = move loweredStatements;
      expressions[expressionIndex].labels[3] = "lowered-block";
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
      statements,
      bodyStatementStart,
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
    const mutexResultType = try lowerModuleTypeName(
      program,
      importedTypes,
      expressions[expressionIndex].labels[2]
    );
    let returnStatement = bodyStatementStart;
    while (returnStatement < statements.length) {
      if (
        statements[returnStatement].kind
          == LoweredStatementKind.returnStatement
      ) statements[returnStatement].type = Option.some(LoweredType({
        kind: mutexResultType.kind,
        name: mutexResultType.name.copyBytes(
          0,
          mutexResultType.name.byteLength
        ),
      }));
      returnStatement = returnStatement + 1;
    }
    const bodyExpressionEnd = expressions.length;
    let mutexLiveFlags = Array<LoweredLiveFlag>();
    const inherited = Array<LoweredCleanup>();
    const loopCleanups = Array<LoweredCleanup>();
    const mutexMoveIndex = cleanupMoveIndex(
      program,
      evidence,
      arena,
      expressions
    );
    const introduced = try planCleanupSequence(
      program,
      importedTypes,
      evidence,
      arena,
      ownerName,
      sourceStatements,
      loweredStatements,
      inherited,
      expressions,
      mutexMoveIndex,
      inout statements,
      inout mutexLiveFlags,
      false,
      false,
      loopCleanups
    );
    attachMoveLiveFlagsRange(
      inout expressions,
      mutexLiveFlags,
      bodyExpressionStart,
      bodyExpressionEnd
    );
    if (
      introduced.length > 0
      && sequenceFallsThrough(arena, sourceStatements)
      && loweredSequenceFallsThrough(statements, loweredStatements)
    ) {
      let bodyCleanups = Array<LoweredCleanup>();
      appendCleanupCopies(inout bodyCleanups, introduced);
      const body = statements.length;
      statements.push(LoweredStatement({
        kind: LoweredStatementKind.blockStatement,
        mutableBinding: false,
        name: "",
        type: Option<LoweredType>.none,
        expression: Option<usize>.none,
        secondExpression: Option<usize>.none,
        children: move loweredStatements,
        cleanups: move bodyCleanups,
        liveFlag: "",
        labels: Array<String>(),
        matchConsumesSubject: false,
        matchBindingNeedsCleanup: false,
      }));
      loweredStatements = Array<usize>(body);
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

function expressionTreeContainsAwait(
  in tree: ExpressionTree,
  index: usize
): boolean {
  if (
    tree.nodes[index].kind == ExpressionKind.awaitExpression
    || tree.nodes[index].kind == ExpressionKind.executorPlacementExpression
  ) return true;
  for (const child of tree.nodes[index].children) {
    if (expressionTreeContainsAwait(tree, child)) return true;
  }
  return false;
}

function expressionTreeIsSchedulerYieldAwait(
  in program: Program,
  in tree: ExpressionTree,
  index: usize
): boolean {
  if (
    tree.nodes[index].kind != ExpressionKind.awaitExpression
    || tree.nodes[index].children.length != 1
  ) return false;
  const operation = tree.nodes[index].children[0];
  if (
    tree.nodes[operation].kind != ExpressionKind.callExpression
    || tree.nodes[operation].children.length != 1
  ) return false;
  const callee = tree.nodes[operation].children[0];
  if (
    tree.nodes[callee].kind != ExpressionKind.memberExpression
    || tree.nodes[callee].value != "yield"
    || tree.nodes[callee].children.length != 1
  ) return false;
  const namespace = tree.nodes[callee].children[0];
  return tree.nodes[namespace].kind == ExpressionKind.identifierExpression
    && isImportedStandardBinding(
      program,
      "std/async",
      "scheduler",
      tree.nodes[namespace].value
  );
}

function statementIsSchedulerYieldAwait(
  in program: Program,
  in arena: StatementArena,
  index: usize
): boolean {
  if (arena.nodes[index].kind != StatementKind.expressionStatement) {
    return false;
  }
  return match (in arena.nodes[index].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const root = tree.root;
        select expressionTreeIsSchedulerYieldAwait(program, tree, root);
      }
      none => false;
    }
    none => false;
  };
}

function functionUsesFirstTierSchedulerYield(
  in program: Program,
  in declaration: FunctionDeclaration
): boolean {
  if (declaration.body.roots.length < 2) return false;
  const firstRoot = declaration.body.roots[0];
  if (!statementIsSchedulerYieldAwait(
    program,
    declaration.body,
    firstRoot
  )) return false;
  let rootIndex: usize = 1;
  while (rootIndex < declaration.body.roots.length) {
    const root = declaration.body.roots[rootIndex];
    if (statementContainsSuspension(
      declaration.body,
      root
    )) return false;
    rootIndex = rootIndex + 1;
  }
  return true;
}

function statementIsTaskScopeJoinAwait(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in arena: StatementArena,
  index: usize
): boolean {
  if (arena.nodes[index].kind != StatementKind.expressionStatement) {
    return false;
  }
  return match (in arena.nodes[index].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const root = tree.root;
        if (
          tree.nodes[root].kind != ExpressionKind.awaitExpression
          || tree.nodes[root].children.length != 1
        ) return false;
        const call = tree.nodes[root].children[0];
        if (
          tree.nodes[call].kind != ExpressionKind.callExpression
          || tree.nodes[call].children.length != 1
        ) return false;
        const callee = tree.nodes[call].children[0];
        if (
          tree.nodes[callee].kind != ExpressionKind.memberExpression
          || tree.nodes[callee].children.length != 1
          || (
            tree.nodes[callee].value != "close"
            && tree.nodes[callee].value != "cancel"
          )
        ) return false;
        const receiver = tree.nodes[callee].children[0];
        return match (evidenceResolvedExpressionTypeName(
          program,
          importedTypes,
          evidence,
          tree,
          receiver
        )) {
          some(name) => name == "TaskScope";
          none => false;
        };
      }
      none => false;
    }
    none => false;
  };
}

function expressionTreeContainsMainDelayAwait(
  in program: Program,
  in tree: ExpressionTree,
  index: usize
): boolean {
  if (
    tree.nodes[index].kind == ExpressionKind.awaitExpression
    && tree.nodes[index].children.length == 1
  ) {
    const operation = tree.nodes[index].children[0];
    if (
      tree.nodes[operation].kind == ExpressionKind.callExpression
      && tree.nodes[operation].children.length == 2
    ) {
      const callee = tree.nodes[operation].children[0];
      if (
        tree.nodes[callee].kind == ExpressionKind.identifierExpression
        && isImportedStandardBinding(
          program,
          "std/time",
          "delay",
          tree.nodes[callee].value
        )
      ) return true;
    }
  }
  if (tree.nodes[index].kind == ExpressionKind.closureExpression) {
    return false;
  }
  for (const child of tree.nodes[index].children) {
    if (expressionTreeContainsMainDelayAwait(program, tree, child)) {
      return true;
    }
  }
  return false;
}

function statementContainsMainDelayAwait(
  in program: Program,
  in arena: StatementArena,
  index: usize
): boolean {
  match (in arena.nodes[index].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const root = tree.root;
        if (expressionTreeContainsMainDelayAwait(
          program,
          tree,
          root
        )) return true;
      }
      none => {}
    }
    none => {}
  }
  for (const child of arena.nodes[index].children) {
    if (statementContainsMainDelayAwait(program, arena, child)) return true;
  }
  return false;
}

function functionContainsMainDelayAwait(
  in program: Program,
  in declaration: FunctionDeclaration
): boolean {
  for (const root of declaration.body.roots) {
    if (statementContainsMainDelayAwait(program, declaration.body, root)) {
      return true;
    }
  }
  return false;
}

function statementIsFirstTierTailAwait(
  in arena: StatementArena,
  index: usize
): boolean {
  if (arena.nodes[index].kind != StatementKind.returnStatement) {
    return false;
  }
  match (in arena.nodes[index].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        let awaitRoot = tree.root;
        if (
          tree.nodes[awaitRoot].kind == ExpressionKind.tryExpression
          && tree.nodes[awaitRoot].children.length == 1
        ) awaitRoot = tree.nodes[awaitRoot].children[0];
        if (
          tree.nodes[awaitRoot].kind != ExpressionKind.awaitExpression
          || tree.nodes[awaitRoot].children.length != 1
        ) return false;
        const operation = tree.nodes[awaitRoot].children[0];
        if (
          tree.nodes[operation].kind != ExpressionKind.callExpression
          || tree.nodes[operation].children.length == 0
        ) return false;
        const callee = tree.nodes[operation].children[0];
        return tree.nodes[callee].kind
          == ExpressionKind.identifierExpression;
      }
      none => return false;
    }
    none => return false;
  }
}

function functionUsesFirstTierTailAwait(
  in declaration: FunctionDeclaration
): boolean {
  if (declaration.body.roots.length != 1) return false;
  const root = declaration.body.roots[0];
  return statementIsFirstTierTailAwait(
    declaration.body,
    root
  );
}

function functionUsesFirstTierPlacedMethodTailAwait(
  in declaration: FunctionDeclaration
): boolean {
  if (declaration.body.roots.length != 1) return false;
  const root = declaration.body.roots[0];
  if (
    declaration.body.nodes[root].kind != StatementKind.returnStatement
  ) return false;
  return match (in declaration.body.nodes[root].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const placement = tree.root;
        if (
          tree.nodes[placement].kind
            != ExpressionKind.executorPlacementExpression
          || tree.nodes[placement].value != "await"
          || tree.nodes[placement].labels.length < 3
          || tree.nodes[placement].labels[2] != "call"
          || tree.nodes[placement].children.length != 3
        ) return false;
        const operation = tree.nodes[placement].children[2];
        if (
          tree.nodes[operation].kind != ExpressionKind.callExpression
          || tree.nodes[operation].children.length == 0
        ) return false;
        const callee = tree.nodes[operation].children[0];
        return tree.nodes[callee].kind
          == ExpressionKind.memberExpression;
      }
      none => false;
    }
    none => false;
  };
}

function functionUsesFirstTierPlacedFunctionTailAwait(
  in declaration: FunctionDeclaration
): boolean {
  if (declaration.body.roots.length != 1) return false;
  const root = declaration.body.roots[0];
  if (
    declaration.body.nodes[root].kind != StatementKind.returnStatement
  ) return false;
  return match (in declaration.body.nodes[root].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const placement = tree.root;
        if (
          tree.nodes[placement].kind
            != ExpressionKind.executorPlacementExpression
          || tree.nodes[placement].value != "await"
          || tree.nodes[placement].labels.length < 3
          || tree.nodes[placement].labels[2] != "call"
          || tree.nodes[placement].children.length != 3
        ) return false;
        const operation = tree.nodes[placement].children[2];
        if (
          tree.nodes[operation].kind != ExpressionKind.callExpression
          || tree.nodes[operation].children.length == 0
        ) return false;
        const callee = tree.nodes[operation].children[0];
        return tree.nodes[callee].kind
          == ExpressionKind.identifierExpression;
      }
      none => false;
    }
    none => false;
  };
}

function statementIsFirstTierPlacedFunctionAwaitLocal(
  in arena: StatementArena,
  index: usize
): boolean {
  if (arena.nodes[index].kind != StatementKind.variableStatement) {
    return false;
  }
  return match (in arena.nodes[index].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        let placement = tree.root;
        if (
          (
            tree.nodes[placement].kind == ExpressionKind.tryExpression
            || tree.nodes[placement].kind
              == ExpressionKind.attemptExpression
          )
          && tree.nodes[placement].children.length == 1
        ) placement = tree.nodes[placement].children[0];
        if (
          tree.nodes[placement].kind
            != ExpressionKind.executorPlacementExpression
          || tree.nodes[placement].value != "await"
          || tree.nodes[placement].labels.length < 3
          || tree.nodes[placement].labels[2] != "call"
          || tree.nodes[placement].children.length != 3
        ) return false;
        const operation = tree.nodes[placement].children[2];
        if (
          tree.nodes[operation].kind != ExpressionKind.callExpression
          || tree.nodes[operation].children.length == 0
        ) return false;
        const callee = tree.nodes[operation].children[0];
        for (const child of tree.nodes[placement].children) {
          if (expressionTreeContainsSuspension(
            arena,
            tree,
            child
          )) return false;
        }
        return tree.nodes[callee].kind
          == ExpressionKind.identifierExpression;
      }
      none => false;
    }
    none => false;
  };
}

function statementIsFirstTierPlacedMethodAwaitLocal(
  in arena: StatementArena,
  index: usize
): boolean {
  if (arena.nodes[index].kind != StatementKind.variableStatement) {
    return false;
  }
  return match (in arena.nodes[index].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        let placement = tree.root;
        if (
          (
            tree.nodes[placement].kind == ExpressionKind.tryExpression
            || tree.nodes[placement].kind
              == ExpressionKind.attemptExpression
          )
          && tree.nodes[placement].children.length == 1
        ) placement = tree.nodes[placement].children[0];
        if (
          tree.nodes[placement].kind
            != ExpressionKind.executorPlacementExpression
          || tree.nodes[placement].value != "await"
          || tree.nodes[placement].labels.length < 3
          || tree.nodes[placement].labels[2] != "call"
          || tree.nodes[placement].children.length != 3
        ) return false;
        const operation = tree.nodes[placement].children[2];
        if (
          tree.nodes[operation].kind != ExpressionKind.callExpression
          || tree.nodes[operation].children.length == 0
        ) return false;
        const callee = tree.nodes[operation].children[0];
        for (const child of tree.nodes[placement].children) {
          if (expressionTreeContainsSuspension(
            arena,
            tree,
            child
          )) return false;
        }
        return tree.nodes[callee].kind
          == ExpressionKind.memberExpression;
      }
      none => false;
    }
    none => false;
  };
}

function functionUsesFirstTierPlacedFunctionLinearAwait(
  in declaration: FunctionDeclaration
): boolean {
  if (declaration.body.roots.length < 2) return false;
  let awaitCount: usize = 0;
  for (const root of declaration.body.roots) {
    if (statementIsFirstTierPlacedFunctionAwaitLocal(
      declaration.body,
      root
    )) {
      awaitCount = awaitCount + 1;
      continue;
    }
    if (statementContainsSuspension(declaration.body, root)) return false;
  }
  return awaitCount == 1;
}

function functionUsesFirstTierPlacedMethodLinearAwait(
  in declaration: FunctionDeclaration
): boolean {
  if (declaration.body.roots.length < 2) return false;
  let awaitCount: usize = 0;
  for (const root of declaration.body.roots) {
    if (statementIsFirstTierPlacedMethodAwaitLocal(
      declaration.body,
      root
    )) {
      awaitCount = awaitCount + 1;
      continue;
    }
    if (statementContainsSuspension(declaration.body, root)) return false;
  }
  return awaitCount == 1;
}

function rewritePlacedFunctionAwaitAtRoot(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in declaration: FunctionDeclaration,
  sourceRoot: usize,
  loweredRoot: usize,
  inout expressions: Array<LoweredExpression>,
  inout statements: Array<LoweredStatement>
): void throws String {
  let callableIdentity = "";
  match (in declaration.body.nodes[sourceRoot].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        let placement = tree.root;
        if (
          (
            tree.nodes[placement].kind == ExpressionKind.tryExpression
            || tree.nodes[placement].kind == ExpressionKind.attemptExpression
          )
          && tree.nodes[placement].children.length == 1
        ) placement = tree.nodes[placement].children[0];
        const callInput = tree.nodes[placement].children[2];
        const resolutionIndex = resolvedCallResolutionIndex(
          evidence,
          tree,
          callInput
        );
        if (resolutionIndex >= evidence.callResolutions.length) {
          throw "native placed async tail lost its call resolution";
        }
        callableIdentity = try moduleCallFunctionTypeIdentity(
          program,
          importedTypes,
          evidence.callResolutions[resolutionIndex]
        );
      }
      none => throw "native placed async tail lost its source tree";
    }
    none => throw "native placed async tail lost its source expression";
  }
  let placedIndex = expressions.length;
  let loweredTry = statements.length;
  match (in statements[loweredRoot].expression) {
    some(found) => placedIndex = found;
    none => if (
      statements[loweredRoot].kind == LoweredStatementKind.localStatement
      && statements[loweredRoot].children.length == 1
    ) {
      const nested = statements[loweredRoot].children[0];
      if (statements[nested].kind == LoweredStatementKind.tryStatement) {
        loweredTry = nested;
        match (in statements[nested].expression) {
          some(found) => placedIndex = found;
          none => {}
        }
      }
    }
  }
  if (placedIndex >= expressions.length) {
    throw "native placed async tail lost its lowered expression";
  }
  if (
    expressions[placedIndex].kind
      != LoweredExpressionKind.threadMainCall
    || expressions[placedIndex].children.length == 0
  ) throw "native placed async tail lost its thread.main call";
  const runnerIndex = expressions[placedIndex].children[0];
  if (
    expressions[runnerIndex].kind != LoweredExpressionKind.directCall
    || expressions[runnerIndex].children.length == 0
  ) throw "native placed async tail lost its direct runner";
  const targetIndex = expressions[runnerIndex].children[0];
  if (expressions[targetIndex].kind != LoweredExpressionKind.localValue) {
    throw "native placed async tail lost its function target";
  }
  const targetName = expressions[targetIndex].value.copyBytes(
    0,
    expressions[targetIndex].value.byteLength
  );
  let arguments = Array<usize>();
  let argument: usize = 1;
  while (argument < expressions[placedIndex].children.length) {
    arguments.push(expressions[placedIndex].children[argument]);
    argument = argument + 1;
  }
  let parameterModes = Array<String>();
  for (const mode of expressions[runnerIndex].labels) {
    parameterModes.push(mode.copyBytes(0, mode.byteLength));
  }
  // The ordinary async parent no longer owns a worker-placement bridge.
  // Retire the orphaned evidence before helper discovery scans every lowered
  // expression, including expressions no longer reachable from a root.
  expressions[placedIndex].kind = LoweredExpressionKind.booleanValue;
  expressions[placedIndex].value = "false";
  expressions[placedIndex].children = Array<usize>();
  expressions[placedIndex].labels = Array<String>();
  let callableLabels = Array<String>();
  callableLabels.push(callableIdentity.copyBytes(
    0,
    callableIdentity.byteLength
  ));
  const callable = pushExpression(
    inout expressions,
    LoweredExpressionKind.directFunctionValue,
    targetName,
    Array<usize>(),
    callableLabels
  );
  let children = Array<usize>();
  children.push(callable);
  for (const value of arguments) {
    children.push(value);
  }
  const awaited = pushExpression(
    inout expressions,
    LoweredExpressionKind.asyncFunctionAwait,
    callableIdentity,
    children,
    parameterModes
  );
  if (loweredTry < statements.length) {
    if (statements[loweredTry].labels.length < 2) {
      throw "native placed async local received a malformed try";
    }
    const innerResult = statements[loweredTry].name.copyBytes(
      0,
      statements[loweredTry].name.byteLength
    );
    const outerResult = statements[loweredTry].labels[1].copyBytes(
      0,
      statements[loweredTry].labels[1].byteLength
    );
    statements[loweredRoot].labels.push("async-try");
    statements[loweredRoot].labels.push(move innerResult);
    statements[loweredRoot].labels.push(move outerResult);
    statements[loweredRoot].children = Array<usize>();
  }
  statements[loweredRoot].expression = Option.some(awaited);
}

function rewritePlacedFunctionAwaits(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in declaration: FunctionDeclaration,
  in roots: Array<usize>,
  inout expressions: Array<LoweredExpression>,
  inout statements: Array<LoweredStatement>
): void throws String {
  if (
    functionUsesFirstTierPlacedFunctionTailAwait(declaration)
    && roots.length == 1
  ) {
    const sourceRoot = declaration.body.roots[0];
    try rewritePlacedFunctionAwaitAtRoot(
      program,
      importedTypes,
      evidence,
      declaration,
      sourceRoot,
      roots[0],
      inout expressions,
      inout statements
    );
    return;
  }
  const placedLinear = functionUsesFirstTierPlacedFunctionLinearAwait(
    declaration
  );
  const doubleAwait = functionUsesFirstTierDoubleAwait(declaration);
  if (!placedLinear && !doubleAwait) return;
  let position: usize = 0;
  let rewrote = false;
  while (position < declaration.body.roots.length) {
    const sourceRoot = declaration.body.roots[position];
    if (statementIsFirstTierPlacedFunctionAwaitLocal(
      declaration.body,
      sourceRoot
    )) {
      if (position >= roots.length) {
        throw "native placed async local lost its lowered root";
      }
      try rewritePlacedFunctionAwaitAtRoot(
        program,
        importedTypes,
        evidence,
        declaration,
        sourceRoot,
        roots[position],
        inout expressions,
        inout statements
      );
      rewrote = true;
      if (placedLinear) return;
    }
    position = position + 1;
  }
  if (placedLinear && !rewrote) {
    throw "native placed async local lost its source root";
  }
}

function statementUsesOnlyFirstTierTailAwaitSuspension(
  in arena: StatementArena,
  index: usize
): boolean {
  if (!statementContainsSuspension(arena, index)) return true;
  if (statementIsFirstTierTailAwait(arena, index)) return true;
  if (
    arena.nodes[index].kind == StatementKind.asyncScopeStatement
    || arena.nodes[index].kind == StatementKind.forAwaitStatement
    || arena.nodes[index].kind == StatementKind.forTryAwaitStatement
  ) return false;
  match (in arena.nodes[index].expression) {
    some(expression) => match (in expression.tree) {
      some(tree) => {
        const root = tree.root;
        if (!expressionTreeUsesOnlyFirstTierTailAwaitSuspension(
          arena,
          tree,
          root
        )) return false;
      }
      none => {}
    }
    none => {}
  }
  match (in arena.nodes[index].secondExpression) {
    some(expression) => match (in expression.tree) {
      some(tree) => {
        const root = tree.root;
        if (!expressionTreeUsesOnlyFirstTierTailAwaitSuspension(
          arena,
          tree,
          root
        )) return false;
      }
      none => {}
    }
    none => {}
  }
  for (const child of arena.nodes[index].children) {
    if (!statementUsesOnlyFirstTierTailAwaitSuspension(
      arena,
      child
    )) return false;
  }
  return true;
}

function expressionTreeUsesOnlyFirstTierTailAwaitSuspension(
  in arena: StatementArena,
  in tree: ExpressionTree,
  index: usize
): boolean {
  if (
    tree.nodes[index].kind == ExpressionKind.awaitExpression
    || tree.nodes[index].kind
      == ExpressionKind.executorPlacementExpression
  ) return false;
  if (tree.nodes[index].kind == ExpressionKind.closureExpression) return true;
  for (const statement of tree.nodes[index].statements) {
    if (!statementUsesOnlyFirstTierTailAwaitSuspension(
      arena,
      statement
    )) return false;
  }
  for (const child of tree.nodes[index].children) {
    if (!expressionTreeUsesOnlyFirstTierTailAwaitSuspension(
      arena,
      tree,
      child
    )) return false;
  }
  return true;
}

function expressionTreeFirstTierTailAwaitCount(
  in arena: StatementArena,
  in tree: ExpressionTree,
  index: usize
): usize {
  if (tree.nodes[index].kind == ExpressionKind.closureExpression) return 0;
  let count: usize = 0;
  for (const statement of tree.nodes[index].statements) {
    count = count + statementFirstTierTailAwaitCount(arena, statement);
  }
  for (const child of tree.nodes[index].children) {
    count = count + expressionTreeFirstTierTailAwaitCount(
      arena,
      tree,
      child
    );
  }
  return count;
}

function statementFirstTierTailAwaitCount(
  in arena: StatementArena,
  index: usize
): usize {
  if (statementIsFirstTierTailAwait(arena, index)) return 1;
  let count: usize = 0;
  match (in arena.nodes[index].expression) {
    some(expression) => match (in expression.tree) {
      some(tree) => {
        const root = tree.root;
        count = count + expressionTreeFirstTierTailAwaitCount(
          arena,
          tree,
          root
        );
      }
      none => {}
    }
    none => {}
  }
  match (in arena.nodes[index].secondExpression) {
    some(expression) => match (in expression.tree) {
      some(tree) => {
        const root = tree.root;
        count = count + expressionTreeFirstTierTailAwaitCount(
          arena,
          tree,
          root
        );
      }
      none => {}
    }
    none => {}
  }
  for (const child of arena.nodes[index].children) {
    count = count + statementFirstTierTailAwaitCount(arena, child);
  }
  return count;
}

function functionUsesFirstTierMatchedTailAwait(
  in declaration: FunctionDeclaration
): boolean {
  if (declaration.body.roots.length == 0) return false;
  let position: usize = 0;
  while (position + 1 < declaration.body.roots.length) {
    const root = declaration.body.roots[position];
    if (statementContainsSuspension(declaration.body, root)) return false;
    position = position + 1;
  }
  const tail = declaration.body.roots[
    declaration.body.roots.length - 1
  ];
  return declaration.body.nodes[tail].kind == StatementKind.matchStatement
    && statementFirstTierTailAwaitCount(declaration.body, tail) == 1
    && statementUsesOnlyFirstTierTailAwaitSuspension(
      declaration.body,
      tail
    );
}

function statementIsFirstTierAwaitLocal(
  in arena: StatementArena,
  index: usize
): boolean {
  if (arena.nodes[index].kind != StatementKind.variableStatement) {
    return false;
  }
  return match (in arena.nodes[index].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        let root = tree.root;
        // `attempt await` keeps the child's Result as the local value. No
        // propagation rewrite is required; the linear task frame receives
        // and owns the complete Result after the child finishes.
        if (
          tree.nodes[root].kind == ExpressionKind.attemptExpression
          && tree.nodes[root].children.length == 1
        ) root = tree.nodes[root].children[0];
        if (
          tree.nodes[root].kind != ExpressionKind.awaitExpression
          || tree.nodes[root].children.length != 1
        ) return false;
        const operation = tree.nodes[root].children[0];
        if (
          tree.nodes[operation].kind != ExpressionKind.callExpression
          || tree.nodes[operation].children.length == 0
        ) return false;
        const callee = tree.nodes[operation].children[0];
        select tree.nodes[callee].kind
            == ExpressionKind.identifierExpression
          || tree.nodes[callee].kind == ExpressionKind.memberExpression;
      }
      none => false;
    }
    none => false;
  };
}

function functionUsesFirstTierLinearAwait(
  in declaration: FunctionDeclaration
): boolean {
  if (declaration.body.roots.length < 2) return false;
  let awaitCount: usize = 0;
  for (const root of declaration.body.roots) {
    if (!statementContainsSuspension(declaration.body, root)) continue;
    if (!statementIsFirstTierAwaitLocal(
      declaration.body,
      root
    )) return false;
    awaitCount = awaitCount + 1;
  }
  return awaitCount == 1;
}

function functionUsesFirstTierDoubleAwait(
  in declaration: FunctionDeclaration
): boolean {
  if (declaration.body.roots.length < 3) return false;
  let awaitCount: usize = 0;
  for (const root of declaration.body.roots) {
    if (!statementContainsSuspension(declaration.body, root)) continue;
    if (
      !statementIsFirstTierAwaitLocal(declaration.body, root)
      && !statementIsFirstTierPlacedFunctionAwaitLocal(
        declaration.body,
        root
      )
    ) return false;
    awaitCount = awaitCount + 1;
  }
  return awaitCount == 2;
}

function functionUsesFirstTierPrefixedTailAwait(
  in declaration: FunctionDeclaration
): boolean {
  if (declaration.body.roots.length < 2) return false;
  let position: usize = 0;
  while (position + 1 < declaration.body.roots.length) {
    const root = declaration.body.roots[position];
    if (
      statementContainsSuspension(declaration.body, root)
    ) return false;
    const kind = declaration.body.nodes[root].kind;
    if (
      kind != StatementKind.variableStatement
      && kind != StatementKind.ifStatement
      && kind != StatementKind.whileStatement
      && kind != StatementKind.assignmentStatement
      && kind != StatementKind.expressionStatement
    ) return false;
    if (kind == StatementKind.variableStatement) {
      if (declaration.body.nodes[root].children.length > 0) return false;
      match (in declaration.body.nodes[root].expression) {
        some(_) => {}
        none => return false;
      }
    }
    position = position + 1;
  }
  const tail = declaration.body.roots[
    declaration.body.roots.length - 1
  ];
  return statementIsFirstTierTailAwait(declaration.body, tail);
}

function expressionTreeContainsSuspension(
  in arena: StatementArena,
  in tree: ExpressionTree,
  index: usize
): boolean {
  if (
    tree.nodes[index].kind == ExpressionKind.awaitExpression
    || tree.nodes[index].kind
      == ExpressionKind.executorPlacementExpression
  ) return true;
  if (tree.nodes[index].kind == ExpressionKind.closureExpression) return false;
  for (const statement of tree.nodes[index].statements) {
    if (statementContainsSuspension(arena, statement)) return true;
  }
  for (const child of tree.nodes[index].children) {
    if (expressionTreeContainsSuspension(arena, tree, child)) return true;
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
        if (expressionTreeContainsSuspension(arena, tree, root)) return true;
      }
      none => {}
    }
    none => {}
  }
  match (in arena.nodes[index].secondExpression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const root = tree.root;
        if (expressionTreeContainsSuspension(arena, tree, root)) return true;
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

function functionContainsSuspension(
  in declaration: FunctionDeclaration
): boolean {
  for (const root of declaration.body.roots) {
    if (statementContainsSuspension(declaration.body, root)) return true;
  }
  return false;
}

function statementContainsLoopControl(
  in arena: StatementArena,
  index: usize
): boolean {
  if (
    arena.nodes[index].kind == StatementKind.breakStatement
    || arena.nodes[index].kind == StatementKind.continueStatement
  ) return true;
  for (const child of arena.nodes[index].children) {
    if (statementContainsLoopControl(arena, child)) return true;
  }
  return false;
}

function statementContainsFunctionExit(
  in arena: StatementArena,
  index: usize
): boolean {
  if (
    arena.nodes[index].kind == StatementKind.returnStatement
    || arena.nodes[index].kind == StatementKind.throwStatement
  ) return true;
  for (const child of arena.nodes[index].children) {
    if (statementContainsFunctionExit(arena, child)) return true;
  }
  return false;
}

function statementTreeContainsTry(
  in arena: StatementArena,
  index: usize
): boolean {
  if (statementExpressionContainsTry(arena, index)) return true;
  for (const child of arena.nodes[index].children) {
    if (statementTreeContainsTry(arena, child)) return true;
  }
  return false;
}

function statementContainsNestedLoopOrMatch(
  in arena: StatementArena,
  index: usize
): boolean {
  if (
    arena.nodes[index].kind == StatementKind.whileStatement
    || arena.nodes[index].kind == StatementKind.forStatement
    || arena.nodes[index].kind == StatementKind.matchStatement
  ) return true;
  for (const child of arena.nodes[index].children) {
    if (statementContainsNestedLoopOrMatch(arena, child)) return true;
  }
  return false;
}

function statementTreeWritesName(
  in program: Program,
  in evidence: ModuleSemanticEvidence,
  in arena: StatementArena,
  index: usize,
  in name: String
): boolean {
  if (
    arena.nodes[index].kind == StatementKind.assignmentStatement
  ) {
    match (in arena.nodes[index].expression) {
      some(target) => {
        if (syntaxIsIdentifier(target, name)) return true;
      }
      none => {}
    }
  }
  if (statementExpressionWritesName(
    program,
    evidence,
    arena,
    index,
    name
  )) return true;
  for (const child of arena.nodes[index].children) {
    if (statementTreeWritesName(
      program,
      evidence,
      arena,
      child,
      name
    )) return true;
  }
  return false;
}

function mainDelayMillisecondsAtStatement(
  in program: Program,
  in arena: StatementArena,
  in ownerName: String,
  statementIndex: usize
): String throws String {
  if (!statementContainsSuspension(arena, statementIndex)) return "";
  if (
    arena.nodes[statementIndex].kind != StatementKind.expressionStatement
  ) {
    throw `native lowering requires every suspension in ${ownerName} to be an await delay(integer-literal) directly inside its supported statement sequence`;
  }
  match (in arena.nodes[statementIndex].expression) {
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
  throw `native lowering requires every suspension in ${ownerName} to be an await delay(integer-literal) directly inside its supported statement sequence`;
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
  match (in arena.nodes[index].secondExpression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const root = tree.root;
        if (expressionTreeContainsTry(tree, root)) return true;
      }
      none => {}
    }
    none => {}
  }
  return false;
}

function statementHasDirectTryExpression(
  in arena: StatementArena,
  index: usize
): boolean {
  match (in arena.nodes[index].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const root = tree.root;
        if (tree.nodes[root].kind == ExpressionKind.tryExpression) return true;
      }
      none => {}
    }
    none => {}
  }
  match (in arena.nodes[index].secondExpression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const root = tree.root;
        if (tree.nodes[root].kind == ExpressionKind.tryExpression) return true;
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

function loweredRootsDeclareLocal(
  in statements: Array<LoweredStatement>,
  in roots: Array<usize>,
  in name: String
): boolean {
  for (const root of roots) {
    if (
      statements[root].kind == LoweredStatementKind.localStatement
      && statements[root].name == name
    ) return true;
  }
  return false;
}

function loweredSegmentsDeclareLocal(
  in statements: Array<LoweredStatement>,
  in segments: Array<LoweredMainDelaySegment>,
  in currentRoots: Array<usize>,
  in name: String
): boolean {
  if (loweredRootsDeclareLocal(statements, currentRoots, name)) return true;
  for (const segment of segments) {
    if (loweredRootsDeclareLocal(statements, segment.roots, name)) {
      return true;
    }
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
        const directResult = try directThrowingCallResult(
          program,
          importedTypes,
          evidence,
          tree,
          attempted,
          ownerName
        );
        const resolvedSuccessTypeName = staticallyResolvedExpressionTypeName(
          program,
          importedTypes,
          evidence,
          arena,
          ownerName,
          tree,
          nestedTry
        );
        let directSuccessTypeName = Option<String>.none;
        match (in directResult) {
          some(declaration) => {
            for (const variant of declaration.variants) {
              if (variant.name != "success") continue;
              match (in variant.payload) {
                some(payload) => directSuccessTypeName = Option.some(
                  payload.name.copyBytes(0, payload.name.byteLength)
                );
                none => {}
              }
            }
          }
          none => {}
        }
        let successTypeName = "";
        match (resolvedSuccessTypeName) {
          some(name) => successTypeName = move name;
          none => match (directSuccessTypeName) {
            some(name) => successTypeName = move name;
            none => {}
          }
        }
        if (successTypeName.byteLength == 0) {
          throw `native nested try lowering could not resolve its success type at ${tree.nodes[nestedTry].line}:${tree.nodes[nestedTry].column}`;
        }
        const successType = try lowerModuleTypeName(
          program,
          importedTypes,
          successTypeName
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
    || expressions[parent].kind
      == LoweredExpressionKind.moveStructSpreadValue
    || expressions[parent].kind == LoweredExpressionKind.enumPayloadValue
    || expressions[parent].kind == LoweredExpressionKind.fixedArrayValue
    || expressions[parent].kind == LoweredExpressionKind.mutexValue
    || expressions[parent].kind == LoweredExpressionKind.onceInitialize
  ) return true;
  if (expressions[parent].kind == LoweredExpressionKind.classValue) {
    if (
      expressions[parent].labels.length > 0
      && expressions[parent].labels[0] == "constructor"
    ) {
      return expressions[parent].labels.length > childPosition + 1
        && expressions[parent].labels[childPosition + 1] == "value";
    }
    return true;
  }
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
  if (arena.nodes[index].kind == StatementKind.destructureStatement) {
    if (arena.nodes[index].arrayBindings.length > 0) {
      if (arena.nodes[index].objectBindings.length > 0) {
        throw "native array destructuring received object bindings";
      }
      match (in arena.nodes[index].expression) {
        some(source) => return match (in source.tree) {
          some(tree) => {
            const root = tree.root;
            const sourceTypeName = match (staticallyResolvedExpressionTypeName(
              program,
              importedTypes,
              evidence,
              arena,
              ownerName,
              tree,
              root
            )) {
              some(name) => name;
              none => throw "native array destructuring could not resolve its source type";
            };
            const sourceType = try lowerModuleTypeName(
              program,
              importedTypes,
              sourceTypeName
            );
            if (
              sourceType.kind != LoweredTypeKind.arrayType
              && sourceType.kind != LoweredTypeKind.sliceType
              && sourceType.kind != LoweredTypeKind.fixedArrayType
            ) {
              throw `native array destructuring expected fixed-array, Array, or Slice storage, found ${sourceTypeName}`;
            }
            const sourceValue = try lowerExpressionExpected(
              program,
              importedTypes,
              evidence,
              tree,
              root,
              sourceTypeName,
              inout expressions
            );
            const sourceViewed = stringStartsWith(sourceTypeName, "view ");
            let sourceView = sourceValue;
            if (!sourceViewed) {
              let viewChildren = Array<usize>();
              viewChildren.push(sourceValue);
              sourceView = pushExpression(
                inout expressions,
                LoweredExpressionKind.viewProjection,
                sourceType.name,
                move viewChildren,
                Array<String>()
              );
            }
            const temporaryName = `_z_array_destructure_${arena.nodes[index].offset}`;
            let flattened = Array<usize>();
            let temporaryLabels = Array<String>();
            temporaryLabels.push("array-destructure-source");
            const temporary = statements.length;
            statements.push(LoweredStatement({
              kind: LoweredStatementKind.localStatement,
              mutableBinding: false,
              name: temporaryName.copyBytes(0, temporaryName.byteLength),
              type: Option.some(LoweredType({
                kind: sourceType.kind,
                name: sourceType.name.copyBytes(0, sourceType.name.byteLength),
              })),
              expression: Option.some(sourceView),
              secondExpression: Option<usize>.none,
              children: Array<usize>(),
              cleanups: Array<LoweredCleanup>(),
              liveFlag: "",
              labels: move temporaryLabels,
              matchConsumesSubject: false,
              matchBindingNeedsCleanup: false,
            }));
            flattened.push(temporary);

            let requiredLength: usize = 0;
            for (const binding of arena.nodes[index].arrayBindings) {
              if (binding.kind != ArrayBindingKind.rest) {
                requiredLength = requiredLength + 1;
              }
            }
            if (
              requiredLength > 0
              && sourceType.kind != LoweredTypeKind.fixedArrayType
            ) {
              const lengthReceiver = pushExpression(
                inout expressions,
                LoweredExpressionKind.localValue,
                temporaryName,
                Array<usize>(),
                Array<String>()
              );
              let lengthChildren = Array<usize>();
              lengthChildren.push(lengthReceiver);
              const requireLength = pushExpression(
                inout expressions,
                LoweredExpressionKind.arrayRequireLength,
                `${requiredLength}`,
                move lengthChildren,
                Array<String>()
              );
              const lengthStatement = statements.length;
              statements.push(LoweredStatement({
                kind: LoweredStatementKind.expressionStatement,
                mutableBinding: false,
                name: "",
                type: Option<LoweredType>.none,
                expression: Option.some(requireLength),
                secondExpression: Option<usize>.none,
                children: Array<usize>(),
                cleanups: Array<LoweredCleanup>(),
                liveFlag: "",
                labels: Array<String>(),
                matchConsumesSubject: false,
                matchBindingNeedsCleanup: false,
              }));
              flattened.push(lengthStatement);
            }

            let elementIndex: usize = 0;
            for (const binding of arena.nodes[index].arrayBindings) {
              if (binding.kind == ArrayBindingKind.discard) {
                elementIndex = elementIndex + 1;
                continue;
              }
              let bindingTypeName = "";
              for (const resolution of evidence.bindingResolutions) {
                if (
                  resolution.offset == binding.bindingOffset
                  && resolution.name == binding.bindingName
                ) bindingTypeName = resolution.typeName.copyBytes(
                  0,
                  resolution.typeName.byteLength
                );
              }
              if (bindingTypeName.byteLength == 0) {
                throw `native array destructuring could not resolve binding ${binding.bindingName}`;
              }
              const bindingType = try lowerModuleTypeName(
                program,
                importedTypes,
                bindingTypeName
              );
              const receiver = pushExpression(
                inout expressions,
                LoweredExpressionKind.localValue,
                temporaryName,
                Array<usize>(),
                Array<String>()
              );
              const offset = pushExpression(
                inout expressions,
                LoweredExpressionKind.integerValue,
                `${elementIndex}`,
                Array<usize>(),
                Array<String>()
              );
              if (binding.kind == ArrayBindingKind.rest) {
                let sliceChildren = Array<usize>();
                sliceChildren.push(receiver);
                sliceChildren.push(offset);
                const sliceValue = pushExpression(
                  inout expressions,
                  LoweredExpressionKind.arraySlice,
                  sourceType.name,
                  move sliceChildren,
                  Array<String>()
                );
                let bindingLabels = Array<String>();
                bindingLabels.push("array-destructure-binding");
                const local = statements.length;
                statements.push(LoweredStatement({
                  kind: LoweredStatementKind.localStatement,
                  mutableBinding: false,
                  name: binding.bindingName.copyBytes(
                    0,
                    binding.bindingName.byteLength
                  ),
                  type: Option.some(LoweredType({
                    kind: bindingType.kind,
                    name: bindingType.name.copyBytes(
                      0,
                      bindingType.name.byteLength
                    ),
                  })),
                  expression: Option.some(sliceValue),
                  secondExpression: Option<usize>.none,
                  children: Array<usize>(),
                  cleanups: Array<LoweredCleanup>(),
                  liveFlag: "",
                  labels: move bindingLabels,
                  matchConsumesSubject: false,
                  matchBindingNeedsCleanup: false,
                }));
                flattened.push(local);
                continue;
              }
              let elementChildren = Array<usize>();
              elementChildren.push(receiver);
              elementChildren.push(offset);
              let elementLabels = Array<String>();
              elementLabels.push("view");
              elementLabels.push("bounds-proven");
              const element = pushExpression(
                inout expressions,
                LoweredExpressionKind.arrayIndex,
                sourceType.name,
                move elementChildren,
                move elementLabels
              );
              let bindingValue = element;
              if (stringStartsWith(bindingTypeName, "view ")) {
                let projected = Array<usize>();
                projected.push(element);
                bindingValue = pushExpression(
                  inout expressions,
                  LoweredExpressionKind.viewProjection,
                  bindingTypeName,
                  move projected,
                  Array<String>()
                );
              }
              let bindingLabels = Array<String>();
              bindingLabels.push("array-destructure-binding");
              const local = statements.length;
              statements.push(LoweredStatement({
                kind: LoweredStatementKind.localStatement,
                mutableBinding: arena.nodes[index].mutableBinding,
                name: binding.bindingName.copyBytes(
                  0,
                  binding.bindingName.byteLength
                ),
                type: Option.some(move bindingType),
                expression: Option.some(bindingValue),
                secondExpression: Option<usize>.none,
                children: Array<usize>(),
                cleanups: Array<LoweredCleanup>(),
                liveFlag: "",
                labels: move bindingLabels,
                matchConsumesSubject: false,
                matchBindingNeedsCleanup: false,
              }));
              flattened.push(local);
              elementIndex = elementIndex + 1;
            }
            let labels = Array<String>();
            labels.push("destructure-normalized");
            const block = statements.length;
            statements.push(LoweredStatement({
              kind: LoweredStatementKind.blockStatement,
              mutableBinding: false,
              name: "",
              type: Option<LoweredType>.none,
              expression: Option<usize>.none,
              secondExpression: Option<usize>.none,
              children: move flattened,
              cleanups: Array<LoweredCleanup>(),
              liveFlag: "",
              labels: move labels,
              matchConsumesSubject: false,
              matchBindingNeedsCleanup: false,
            }));
            select block;
          }
          none => throw "native array destructuring cannot lower an opaque expression";
        };
        none => throw "native array destructuring requires a source expression";
      }
    }
    if (
      arena.nodes[index].objectBindings.length == 0
      || arena.nodes[index].mutableBinding
    ) throw "native lowering currently supports immutable object destructuring only";
    match (in arena.nodes[index].expression) {
      some(source) => return match (in source.tree) {
        some(tree) => {
        const root = tree.root;
        const sourceTypeName = match (staticallyResolvedExpressionTypeName(
          program,
          importedTypes,
          evidence,
          arena,
          ownerName,
          tree,
          root
        )) {
          some(name) => name;
          none => throw "native object destructuring could not resolve its source type";
        };
        const sourceType = try lowerModuleTypeName(
          program,
          importedTypes,
          sourceTypeName
        );
        const sourceNeedsCleanup = moduleTypeNeedsCleanup(
          program,
          importedTypes,
          sourceType
        );
        const sourceValue = try lowerExpressionExpected(
          program,
          importedTypes,
          evidence,
          tree,
          root,
          sourceTypeName,
          inout expressions
        );
        const temporaryName = `_z_destructure_${arena.nodes[index].offset}`;
        let flattened = Array<usize>();
        let temporaryLabels = Array<String>();
        temporaryLabels.push("destructure-source");
        const temporary = statements.length;
        statements.push(LoweredStatement({
          kind: LoweredStatementKind.localStatement,
          mutableBinding: false,
          name: temporaryName.copyBytes(0, temporaryName.byteLength),
          type: Option.some(LoweredType({
            kind: sourceType.kind,
            name: sourceType.name.copyBytes(0, sourceType.name.byteLength),
          })),
          expression: Option.some(sourceValue),
          secondExpression: Option<usize>.none,
          children: Array<usize>(),
          cleanups: Array<LoweredCleanup>(),
          liveFlag: "",
          labels: move temporaryLabels,
          matchConsumesSubject: false,
          matchBindingNeedsCleanup: false,
        }));
        flattened.push(temporary);
        for (const objectBinding of arena.nodes[index].objectBindings) {
          let bindingTypeName = "";
          for (const resolution of evidence.bindingResolutions) {
            if (
              resolution.offset == objectBinding.bindingOffset
              && resolution.name == objectBinding.bindingName
            ) bindingTypeName = resolution.typeName.copyBytes(
              0,
              resolution.typeName.byteLength
            );
          }
          if (bindingTypeName.byteLength == 0) {
            throw `native object destructuring could not resolve binding ${objectBinding.bindingName}`;
          }
          const bindingType = try lowerModuleTypeName(
            program,
            importedTypes,
            bindingTypeName
          );
          const receiver = pushExpression(
            inout expressions,
            LoweredExpressionKind.localValue,
            temporaryName,
            Array<usize>(),
            Array<String>()
          );
          let fieldChildren = Array<usize>();
          fieldChildren.push(receiver);
          let fieldLabels = Array<String>();
          if (stringStartsWith(bindingTypeName, "view ")) {
            fieldLabels.push("resultView");
          }
          let fieldValue = pushExpression(
            inout expressions,
            LoweredExpressionKind.fieldValue,
            objectBinding.fieldName,
            fieldChildren,
            fieldLabels
          );
          const borrowedView = stringStartsWith(bindingTypeName, "view ");
          const bindingNeedsCleanup = !borrowedView && moduleTypeNeedsCleanup(
            program,
            importedTypes,
            bindingType
          );
          if (bindingNeedsCleanup) {
            let moveChildren = Array<usize>();
            moveChildren.push(fieldValue);
            fieldValue = pushExpression(
              inout expressions,
              LoweredExpressionKind.moveValue,
              "",
              move moveChildren,
              Array<String>()
            );
          }
          let bindingLabels = Array<String>();
          bindingLabels.push("destructure-binding");
          const local = statements.length;
          statements.push(LoweredStatement({
            kind: LoweredStatementKind.localStatement,
            mutableBinding: false,
            name: objectBinding.bindingName.copyBytes(
              0,
              objectBinding.bindingName.byteLength
            ),
            type: Option.some(move bindingType),
            expression: Option.some(fieldValue),
            secondExpression: Option<usize>.none,
            children: Array<usize>(),
            cleanups: Array<LoweredCleanup>(),
            liveFlag: "",
            labels: move bindingLabels,
            matchConsumesSubject: false,
            matchBindingNeedsCleanup: false,
          }));
          flattened.push(local);
          if (bindingNeedsCleanup) {
            const clearReceiver = pushExpression(
              inout expressions,
              LoweredExpressionKind.localValue,
              temporaryName,
              Array<usize>(),
              Array<String>()
            );
            let clearFieldChildren = Array<usize>();
            clearFieldChildren.push(clearReceiver);
            const clearField = pushExpression(
              inout expressions,
              LoweredExpressionKind.fieldValue,
              objectBinding.fieldName,
              move clearFieldChildren,
              Array<String>()
            );
            let emptyChildren = Array<usize>();
            emptyChildren.push(clearField);
            const empty = pushExpression(
              inout expressions,
              LoweredExpressionKind.emptyValue,
              "",
              move emptyChildren,
              Array<String>()
            );
            let clearLabels = Array<String>();
            clearLabels.push("destructure-clear");
            const clear = statements.length;
            statements.push(LoweredStatement({
              kind: LoweredStatementKind.assignmentStatement,
              mutableBinding: false,
              name: "",
              type: Option<LoweredType>.none,
              expression: Option.some(clearField),
              secondExpression: Option.some(empty),
              children: Array<usize>(),
              cleanups: Array<LoweredCleanup>(),
              liveFlag: "",
              labels: move clearLabels,
              matchConsumesSubject: false,
              matchBindingNeedsCleanup: false,
            }));
            flattened.push(clear);
          }
        }
        let labels = Array<String>();
        labels.push("destructure-normalized");
        let blockCleanups = Array<LoweredCleanup>();
        if (sourceNeedsCleanup) {
          blockCleanups.push(LoweredCleanup({
            name: temporaryName.copyBytes(0, temporaryName.byteLength),
            type: LoweredType({
              kind: sourceType.kind,
              name: sourceType.name.copyBytes(0, sourceType.name.byteLength),
            }),
            guard: "",
          }));
        }
        const block = statements.length;
        statements.push(LoweredStatement({
          kind: LoweredStatementKind.blockStatement,
          mutableBinding: false,
          name: "",
          type: Option<LoweredType>.none,
          expression: Option<usize>.none,
          secondExpression: Option<usize>.none,
          children: move flattened,
          cleanups: move blockCleanups,
          liveFlag: "",
          labels: move labels,
          matchConsumesSubject: false,
          matchBindingNeedsCleanup: false,
        }));
          select block;
        }
        none => throw "native object destructuring cannot lower an opaque expression";
      };
      none => throw "native object destructuring requires a source expression";
    }
  }
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
                if (receiverTypeName != "TaskScope") {
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
            const callStart = expressions.length;
            const call = try lowerExpression(
              program,
              importedTypes,
              evidence,
              tree,
              attempted,
              inout expressions
            );
            try completeNativeClosureBlocks(
              program,
              importedTypes,
              evidence,
              arena,
              ownerName,
              index,
              callStart,
              inout expressions,
              inout statements
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
              const callStart = expressions.length;
              const call = try lowerExpression(
                program,
                importedTypes,
                evidence,
                tree,
                attempted,
                inout expressions
              );
              try completeNativeClosureBlocks(
                program,
                importedTypes,
                evidence,
                arena,
                ownerName,
                index,
                callStart,
                inout expressions,
                inout statements
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
              const callStart = expressions.length;
              const call = try lowerExpression(
                program,
                importedTypes,
                evidence,
                tree,
                attempted,
                inout expressions
              );
              try completeNativeClosureBlocks(
                program,
                importedTypes,
                evidence,
                arena,
                ownerName,
                index,
                callStart,
                inout expressions,
                inout statements
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
  } else if (
    arena.nodes[index].kind == StatementKind.blockStatement
    || arena.nodes[index].kind == StatementKind.asyncScopeStatement
  ) {
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
  let objectiveCSetter = "";
  let expression = Option<usize>.none;
  match (in arena.nodes[index].expression) {
    some(source) => {
      const expressionStart = expressions.length;
      let directTryReturn = false;
      let loweredValue: usize = 0;
      let loweredDirectly = false;
      match (in source.tree) {
        some(tree) => {
          const root = tree.root;
          if (
            arena.nodes[index].kind == StatementKind.assignmentStatement
            && tree.nodes[root].kind == ExpressionKind.memberExpression
            && tree.nodes[root].children.length == 1
          ) {
            const receiverInput = tree.nodes[root].children[0];
            match (evidenceResolvedExpressionTypeName(
              program,
              importedTypes,
              evidence,
              tree,
              receiverInput
            )) {
              some(receiverTypeName) => match (objectiveCSetterForOwner(
                importedTypes,
                receiverTypeName,
                tree.nodes[root].value
              )) {
                some(setter) => {
                  objectiveCSetter = move setter;
                  loweredValue = try lowerExpression(
                    program,
                    importedTypes,
                    evidence,
                    tree,
                    receiverInput,
                    inout expressions
                  );
                  loweredDirectly = true;
                }
                none => {}
              }
              none => {}
            }
          }
          if (
            !loweredDirectly
            && tree.nodes[root].kind == ExpressionKind.unsafeExpression
          ) {
            loweredValue = try lowerUnsafeSelectedExpression(
              program,
              importedTypes,
              evidence,
              arena,
              source,
              inout expressions
            );
            loweredDirectly = true;
          }
        }
        none => {}
      }
      if (!loweredDirectly && arena.nodes[index].kind == StatementKind.returnStatement) {
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
              match (ownerReturnTypeName(program, ownerName)) {
                some(name) => expectedTypeName = move name;
                none => {}
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
              loweredValue = wrapImplicitOwnedTransfer(
                tree,
                root,
                loweredValue,
                inout expressions
              );
              if (
                tree.nodes[root].kind == ExpressionKind.memberExpression
                && sourceExpressionRootsInThis(tree, root)
                && expressions[loweredValue].kind
                  != LoweredExpressionKind.moveValue
              ) {
                loweredValue = pushExpression(
                  inout expressions,
                  LoweredExpressionKind.moveValue,
                  "",
                  Array<usize>(loweredValue),
                  Array<String>()
                );
              }
            }
          }
          none => throw "native lowering cannot lower an opaque expression";
        }
      } else if (!loweredDirectly) {
        let expectedTypeName = "";
        if (arena.nodes[index].kind == StatementKind.variableStatement) {
          match (in arena.nodes[index].typeAnnotation) {
            some(annotation) => expectedTypeName = annotation.name.copyBytes(
              0,
              annotation.name.byteLength
            );
            none => {
              for (const binding of evidence.bindingResolutions) {
                if (
                  binding.offset == arena.nodes[index].nameOffset
                  && binding.name == arena.nodes[index].name
                ) expectedTypeName = binding.typeName.copyBytes(
                  0,
                  binding.typeName.byteLength
                );
              }
            }
          }
        }
        if (expectedTypeName.byteLength > 0) {
          match (in source.tree) {
            some(tree) => {
              const root = tree.root;
              loweredValue = try lowerExpressionExpected(
                program,
                importedTypes,
                evidence,
                tree,
                root,
                expectedTypeName,
                inout expressions
              );
              if (arena.nodes[index].kind == StatementKind.variableStatement) {
                const bindingType = try lowerModuleTypeName(
                  program,
                  importedTypes,
                  expectedTypeName
                );
                loweredValue = try wrapOwnedStorage(
                  program,
                  importedTypes,
                  tree,
                  root,
                  expectedTypeName,
                  loweredValue,
                  inout expressions
                );
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
        }
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
          if (
            arena.nodes[index].kind == StatementKind.assignmentStatement
            && expectedTypeName.byteLength > 0
          ) {
            const assignmentType = try lowerModuleTypeName(
              program,
              importedTypes,
              expectedTypeName
            );
            type = Option.some(move assignmentType);
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
            if (expectedTypeName.byteLength > 0) {
              const assignmentType = try lowerModuleTypeName(
                program,
                importedTypes,
                expectedTypeName
              );
              // Contextual callable lowering already turns borrowed stored
              // handles into one owned retain. Wrapping the assignment again
              // would retain twice and leak one environment reference.
              if (assignmentType.kind != LoweredTypeKind.functionType) {
                loweredExpression = try wrapOwnedStorage(
                  program,
                  importedTypes,
                  tree,
                  sourceRoot,
                  expectedTypeName,
                  loweredExpression,
                  inout expressions
                );
              }
            } else {
              loweredExpression = wrapImplicitOwnedTransfer(
                tree,
                sourceRoot,
                loweredExpression,
                inout expressions
              );
            }
          }
          secondExpression = Option.some(loweredExpression);
        }
        none => throw "native lowering cannot lower an opaque expression";
      }
    }
    none => {}
  }
  if (objectiveCSetter.byteLength > 0) {
    const receiver = match (in expression) {
      some(value) => value;
      none => throw "native Objective-C property assignment lost its receiver";
    };
    const value = match (in secondExpression) {
      some(resolved) => resolved;
      none => throw "native Objective-C property assignment lost its value";
    };
    let messageChildren = Array<usize>();
    messageChildren.push(receiver);
    messageChildren.push(value);
    let messageLabels = Array<String>();
    messageLabels.push("instance");
    messageLabels.push("value");
    const message = pushExpression(
      inout expressions,
      LoweredExpressionKind.objectiveCMessageCall,
      objectiveCSetter,
      move messageChildren,
      move messageLabels
    );
    kind = LoweredStatementKind.expressionStatement;
    type = Option<LoweredType>.none;
    expression = Option.some(message);
    secondExpression = Option<usize>.none;
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
  if (arena.nodes[index].kind == StatementKind.asyncScopeStatement) {
    labels.push("async-scope");
  }
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
          if (
            iterableType.kind != LoweredTypeKind.arrayType
            && iterableType.kind != LoweredTypeKind.fixedArrayType
            && iterableType.kind != LoweredTypeKind.mapType
          ) {
            throw `native lowering only supports Array, fixed arrays, and Map for iteration, found ${typeName}`;
          }
          const missingElementType = match (in type) {
            some(_) => false;
            none => true;
          };
          if (missingElementType) {
            match (fixedArrayShape(typeName)) {
              some(shape) => {
                const elementType = try lowerModuleTypeName(
                  program,
                  importedTypes,
                  shape.elementType
                );
                type = Option.some(move elementType);
              }
              none => {}
            }
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
                if (
                  generic.base == "Map"
                  && generic.arguments.length == 2
                ) {
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
                  const mapName = intrinsicMapName(keyType, valueType);
                  type = Option.some(LoweredType({
                    kind: LoweredTypeKind.structType,
                    name: `${mapName}_Entry`,
                  }));
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
          match (fixedArrayShape(typeName)) {
            some(shape) => {
              labels.push("fixed");
              labels.push(shape.length.copyBytes(0, shape.length.byteLength));
            }
            none => {}
          }
          if (iterableType.kind == LoweredTypeKind.mapType) {
            labels.push("map");
          }
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

function appendMainDelayPlaceholder(
  inout statements: Array<LoweredStatement>
): usize {
  const index = statements.length;
  statements.push(LoweredStatement({
    kind: LoweredStatementKind.delayStatement,
    mutableBinding: false,
    name: "",
    type: Option<LoweredType>.none,
    expression: Option<usize>.none,
    secondExpression: Option<usize>.none,
    children: Array<usize>(),
    cleanups: Array<LoweredCleanup>(),
    liveFlag: "",
    labels: Array<String>(),
    matchConsumesSubject: false,
    matchBindingNeedsCleanup: false,
  }));
  return index;
}

function validateMainFrameSourceStatement(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in declaration: FunctionDeclaration,
  in parameters: Array<LoweredParameter>,
  sourceIndex: usize,
  allowParameterTransfer: boolean
): void throws String {
  if (
    declaration.body.nodes[sourceIndex].kind
      != StatementKind.expressionStatement
    && declaration.body.nodes[sourceIndex].kind
      != StatementKind.variableStatement
    && declaration.body.nodes[sourceIndex].kind
      != StatementKind.assignmentStatement
  ) {
    throw `native lowering does not yet preserve control flow across suspension inside a segment in ${declaration.name}; keep it to initialized locals, direct local assignments, and synchronous expression statements`;
  }
  if (
    statementTreeContainsTry(declaration.body, sourceIndex)
    && !statementHasDirectTryExpression(
      declaration.body,
      sourceIndex
    )
  ) {
    throw `native lowering does not yet preserve nested try values across suspension inside a segment in ${declaration.name}; use a direct try binding, assignment, or expression statement`;
  }
  if (
    declaration.body.nodes[sourceIndex].kind
      == StatementKind.variableStatement
  ) {
    match (in declaration.body.nodes[sourceIndex].expression) {
      some(_) => {}
      none => throw `native lowering requires local ${declaration.body.nodes[sourceIndex].name} to be initialized before it crosses a suspension in ${declaration.name}`;
    }
  }
  let parameterIndex: usize = 0;
  while (parameterIndex < declaration.parameters.length) {
    const parameter = view declaration.parameters[parameterIndex];
    if (statementExpressionWritesName(
      program,
      evidence,
      declaration.body,
      sourceIndex,
      parameter.name
    )) {
      throw `native lowering does not yet preserve writes to parameter ${parameter.name} across suspension in ${declaration.name}`;
    }
    if (
      !allowParameterTransfer
      && moduleTypeNeedsCleanup(
        program,
        importedTypes,
        parameters[parameterIndex].type
      )
      && statementMovesName(
        program,
        evidence,
        declaration.body,
        declaration.body.nodes[sourceIndex],
        parameter.name
      )
    ) {
      throw `native lowering does not yet preserve ownership transfer of parameter ${parameter.name} across suspension in ${declaration.name}`;
    }
    parameterIndex = parameterIndex + 1;
  }
}

function validateMainFrameLoweredStatement(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in declaration: FunctionDeclaration,
  in parameters: Array<LoweredParameter>,
  in expressions: Array<LoweredExpression>,
  in statements: Array<LoweredStatement>,
  in prefixRoots: Array<usize>,
  in priorSegments: Array<LoweredMainDelaySegment>,
  in currentRoots: Array<usize>,
  loweredRoot: usize,
  allowParameterTransfer: boolean
): void throws String {
  if (
    statements[loweredRoot].kind
      != LoweredStatementKind.expressionStatement
    && statements[loweredRoot].kind
      != LoweredStatementKind.localStatement
    && statements[loweredRoot].kind
      != LoweredStatementKind.assignmentStatement
    && statements[loweredRoot].kind
      != LoweredStatementKind.tryStatement
  ) {
    throw `native lowering does not yet preserve normalized control flow inside a suspension segment in ${declaration.name}`;
  }
  if (statements[loweredRoot].kind == LoweredStatementKind.localStatement) {
    match (in statements[loweredRoot].expression) {
      some(initializer) => {
        if (
          expressions[initializer].kind == LoweredExpressionKind.viewProjection
          || expressions[initializer].kind
            == LoweredExpressionKind.borrowedTemporary
        ) {
          throw `native lowering does not yet preserve borrowed local ${statements[loweredRoot].name} across suspension in ${declaration.name}`;
        }
      }
      none => {
        if (
          statements[loweredRoot].children.length != 1
          || statements[statements[loweredRoot].children[0]].kind
            != LoweredStatementKind.tryStatement
        ) {
          throw `native lowering lost the initializer for cross-suspension local ${statements[loweredRoot].name}`;
        }
      }
    }
  }
  if (
    statements[loweredRoot].kind
      == LoweredStatementKind.assignmentStatement
  ) {
    const target = match (in statements[loweredRoot].expression) {
      some(value) => value;
      none => throw "native lowering received an assignment without a target";
    };
    if (
      expressions[target].kind != LoweredExpressionKind.localValue
      || (
        !loweredRootsDeclareLocal(
          statements,
          prefixRoots,
          expressions[target].value
        )
        && !loweredSegmentsDeclareLocal(
          statements,
          priorSegments,
          currentRoots,
          expressions[target].value
        )
      )
    ) {
      throw `native lowering only preserves direct local assignment across suspension in ${declaration.name}`;
    }
  }
  if (!allowParameterTransfer) {
    let parameterIndex: usize = 0;
    while (parameterIndex < declaration.parameters.length) {
      if (
        moduleTypeNeedsCleanup(
          program,
          importedTypes,
          parameters[parameterIndex].type
        )
        && loweredStatementDirectlyTransfersBinding(
          expressions,
          statements,
          loweredRoot,
          declaration.parameters[parameterIndex].name
        )
      ) {
        throw `native lowering does not yet preserve ownership transfer of parameter ${declaration.parameters[parameterIndex].name} across suspension in ${declaration.name}`;
      }
      parameterIndex = parameterIndex + 1;
    }
  }
}

function lowerMainDelayBranch(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in declaration: FunctionDeclaration,
  in parameters: Array<LoweredParameter>,
  sourceBlock: usize,
  in prefixRoots: Array<usize>,
  inout expressions: Array<LoweredExpression>,
  inout statements: Array<LoweredStatement>,
  inout block: usize,
  inout outputSegments: Array<LoweredMainDelaySegment>,
  inout outputRoots: Array<usize>
): void throws String {
  if (
    declaration.body.nodes[sourceBlock].kind != StatementKind.blockStatement
  ) {
    throw `native lowering requires a braced branch when if contains suspension in ${declaration.name}`;
  }
  let delayCount: usize = 0;
  let lastDelayPosition: usize = 0;
  let position: usize = 0;
  for (const sourceChild of declaration.body.nodes[sourceBlock].children) {
    if (statementContainsSuspension(declaration.body, sourceChild)) {
      const milliseconds = try mainDelayMillisecondsAtStatement(
        program,
        declaration.body,
        declaration.name,
        sourceChild
      );
      if (milliseconds.byteLength == 0) {
        throw `native lowering lost a structured delay in ${declaration.name}`;
      }
      delayCount = delayCount + 1;
      lastDelayPosition = position;
    }
    position = position + 1;
  }

  let loweredChildren = Array<usize>();
  let segmentRoots = Array<usize>();
  let segments = Array<LoweredMainDelaySegment>();
  position = 0;
  for (const sourceChild of declaration.body.nodes[sourceBlock].children) {
    let milliseconds = "";
    if (statementContainsSuspension(declaration.body, sourceChild)) {
      milliseconds = try mainDelayMillisecondsAtStatement(
        program,
        declaration.body,
        declaration.name,
        sourceChild
      );
    }
    if (milliseconds.byteLength > 0) {
      const placeholder = appendMainDelayPlaceholder(inout statements);
      loweredChildren.push(placeholder);
      segments.push(LoweredMainDelaySegment({
        roots: move segmentRoots,
        milliseconds: move milliseconds,
      }));
      segmentRoots = Array<usize>();
      position = position + 1;
      continue;
    }
    if (delayCount > 0 && position < lastDelayPosition) {
      try validateMainFrameSourceStatement(
        program,
        importedTypes,
        evidence,
        declaration,
        parameters,
        sourceChild,
        true
      );
    }
    const loweredChild = try lowerStatement(
      program,
      importedTypes,
      evidence,
      declaration.body,
      declaration.name,
      sourceChild,
      inout expressions,
      inout statements
    );
    loweredChildren.push(loweredChild);
    if (delayCount > 0 && position < lastDelayPosition) {
      try validateMainFrameLoweredStatement(
        program,
        importedTypes,
        declaration,
        parameters,
        expressions,
        statements,
        prefixRoots,
        segments,
        segmentRoots,
        loweredChild,
        true
      );
    }
    segmentRoots.push(loweredChild);
    position = position + 1;
  }
  block = statements.length;
  statements.push(LoweredStatement({
    kind: LoweredStatementKind.blockStatement,
    mutableBinding: false,
    name: "",
    type: Option<LoweredType>.none,
    expression: Option<usize>.none,
    secondExpression: Option<usize>.none,
    children: move loweredChildren,
    cleanups: Array<LoweredCleanup>(),
    liveFlag: "",
    labels: Array<String>(),
    matchConsumesSubject: false,
    matchBindingNeedsCleanup: false,
  }));
  outputSegments = move segments;
  outputRoots = move segmentRoots;
}

function lowerMainDelayIf(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in declaration: FunctionDeclaration,
  in parameters: Array<LoweredParameter>,
  sourceIf: usize,
  prefixRoots: Array<usize>,
  inout expressions: Array<LoweredExpression>,
  inout statements: Array<LoweredStatement>
): LoweredMainDelayIf throws String {
  if (
    declaration.body.nodes[sourceIf].kind != StatementKind.ifStatement
    || declaration.body.nodes[sourceIf].children.length == 0
    || declaration.body.nodes[sourceIf].children.length > 2
  ) throw `native lowering received a malformed suspending if in ${declaration.name}`;
  if (statementExpressionContainsTry(declaration.body, sourceIf)) {
    throw `native lowering does not yet preserve a throwing if condition across suspension in ${declaration.name}`;
  }
  let parameterIndex: usize = 0;
  while (parameterIndex < declaration.parameters.length) {
    if (
      moduleTypeNeedsCleanup(
        program,
        importedTypes,
        parameters[parameterIndex].type
      )
    ) {
      match (in declaration.body.nodes[sourceIf].expression) {
        some(conditionSyntax) => {
          if (syntaxMovesName(
            program,
            evidence,
            conditionSyntax,
            declaration.parameters[parameterIndex].name
          )) {
            throw `native lowering does not yet preserve ownership transfer of parameter ${declaration.parameters[parameterIndex].name} through a suspending if condition in ${declaration.name}`;
          }
        }
        none => {}
      }
    }
    parameterIndex = parameterIndex + 1;
  }
  let condition: usize = 0;
  match (in declaration.body.nodes[sourceIf].expression) {
    some(source) => match (in source.tree) {
      some(tree) => {
        const root = tree.root;
        condition = try lowerExpression(
          program,
          importedTypes,
          evidence,
          tree,
          root,
          inout expressions
        );
      }
      none => throw "native lowering cannot lower an opaque if condition";
    }
    none => throw "native lowering received an if without a condition";
  }
  const thenSource = declaration.body.nodes[sourceIf].children[0];
  let thenBlock: usize = 0;
  let thenSegments = Array<LoweredMainDelaySegment>();
  let thenRoots = Array<usize>();
  try lowerMainDelayBranch(
    program,
    importedTypes,
    evidence,
    declaration,
    parameters,
    thenSource,
    prefixRoots,
    inout expressions,
    inout statements,
    inout thenBlock,
    inout thenSegments,
    inout thenRoots
  );
  let elseBlock = Option<usize>.none;
  let elseSegments = Array<LoweredMainDelaySegment>();
  let elseRoots = Array<usize>();
  if (declaration.body.nodes[sourceIf].children.length == 2) {
    const elseSource = declaration.body.nodes[sourceIf].children[1];
    let loweredElseBlock: usize = 0;
    try lowerMainDelayBranch(
      program,
      importedTypes,
      evidence,
      declaration,
      parameters,
      elseSource,
      prefixRoots,
      inout expressions,
      inout statements,
      inout loweredElseBlock,
      inout elseSegments,
      inout elseRoots
    );
    elseBlock = Option.some(loweredElseBlock);
  }
  let children = Array<usize>();
  children.push(thenBlock);
  match (in elseBlock) {
    some(block) => children.push(block);
    none => {}
  }
  const loweredIf = statements.length;
  statements.push(LoweredStatement({
    kind: LoweredStatementKind.ifStatement,
    mutableBinding: false,
    name: "",
    type: Option<LoweredType>.none,
    expression: Option.some(condition),
    secondExpression: Option<usize>.none,
    children,
    cleanups: Array<LoweredCleanup>(),
    liveFlag: "",
    labels: Array<String>(),
    matchConsumesSubject: false,
    matchBindingNeedsCleanup: false,
  }));
  return LoweredMainDelayIf({
    statement: loweredIf,
    prefixRoots: move prefixRoots,
    condition,
    thenBlock,
    thenSegments,
    thenRoots,
    elseBlock,
    elseSegments,
    elseRoots,
  });
}

function lowerMainDelayLoopBody(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in declaration: FunctionDeclaration,
  in parameters: Array<LoweredParameter>,
  sourceBlock: usize,
  in prefixRoots: Array<usize>,
  inout expressions: Array<LoweredExpression>,
  inout statements: Array<LoweredStatement>,
  inout block: usize,
  inout outputSegments: Array<LoweredMainDelaySegment>,
  inout outputRoots: Array<usize>
): void throws String {
  if (
    declaration.body.nodes[sourceBlock].kind != StatementKind.blockStatement
  ) {
    throw `native lowering requires a braced body when while contains suspension in ${declaration.name}`;
  }
  let delayCount: usize = 0;
  let lastDelayPosition: usize = 0;
  let controlEndsSegment = false;
  let position: usize = 0;
  for (const sourceChild of declaration.body.nodes[sourceBlock].children) {
    if (statementContainsSuspension(declaration.body, sourceChild)) {
      const milliseconds = try mainDelayMillisecondsAtStatement(
        program,
        declaration.body,
        declaration.name,
        sourceChild
      );
      if (milliseconds.byteLength == 0) {
        throw `native lowering requires direct literal delays inside suspending while body in ${declaration.name}`;
      }
      delayCount = delayCount + 1;
      lastDelayPosition = position;
      controlEndsSegment = false;
      position = position + 1;
      continue;
    }
    if (controlEndsSegment) {
      throw `native lowering requires break, continue, return, or throw to end its synchronous while segment in ${declaration.name}`;
    }
    if (statementContainsNestedLoopOrMatch(
      declaration.body,
      sourceChild
    )) {
      throw `native lowering does not yet preserve nested loop or match inside suspending while in ${declaration.name}`;
    }
    if (
      statementContainsLoopControl(declaration.body, sourceChild)
      || statementContainsFunctionExit(declaration.body, sourceChild)
    ) controlEndsSegment = true;
    position = position + 1;
  }
  if (delayCount == 0) {
    throw `native lowering lost every delay inside the suspending while in ${declaration.name}`;
  }

  let loweredChildren = Array<usize>();
  let segmentRoots = Array<usize>();
  let segments = Array<LoweredMainDelaySegment>();
  position = 0;
  for (const sourceChild of declaration.body.nodes[sourceBlock].children) {
    let milliseconds = "";
    if (statementContainsSuspension(declaration.body, sourceChild)) {
      milliseconds = try mainDelayMillisecondsAtStatement(
        program,
        declaration.body,
        declaration.name,
        sourceChild
      );
    }
    if (milliseconds.byteLength > 0) {
      const placeholder = appendMainDelayPlaceholder(inout statements);
      loweredChildren.push(placeholder);
      segments.push(LoweredMainDelaySegment({
        roots: move segmentRoots,
        milliseconds: move milliseconds,
      }));
      segmentRoots = Array<usize>();
      position = position + 1;
      continue;
    }
    const structuredControl = (
      statementContainsLoopControl(declaration.body, sourceChild)
      || statementContainsFunctionExit(declaration.body, sourceChild)
      || declaration.body.nodes[sourceChild].kind
        == StatementKind.ifStatement
      || declaration.body.nodes[sourceChild].kind
        == StatementKind.blockStatement
    );
    if (
      delayCount > 0
      && position < lastDelayPosition
      && !structuredControl
    ) {
      try validateMainFrameSourceStatement(
        program,
        importedTypes,
        evidence,
        declaration,
        parameters,
        sourceChild,
        false
      );
    }
    const loweredChild = try lowerStatement(
      program,
      importedTypes,
      evidence,
      declaration.body,
      declaration.name,
      sourceChild,
      inout expressions,
      inout statements
    );
    loweredChildren.push(loweredChild);
    if (
      delayCount > 0
      && position < lastDelayPosition
      && !structuredControl
    ) {
      try validateMainFrameLoweredStatement(
        program,
        importedTypes,
        declaration,
        parameters,
        expressions,
        statements,
        prefixRoots,
        segments,
        segmentRoots,
        loweredChild,
        false
      );
    }
    segmentRoots.push(loweredChild);
    position = position + 1;
  }
  block = statements.length;
  statements.push(LoweredStatement({
    kind: LoweredStatementKind.blockStatement,
    mutableBinding: false,
    name: "",
    type: Option<LoweredType>.none,
    expression: Option<usize>.none,
    secondExpression: Option<usize>.none,
    children: move loweredChildren,
    cleanups: Array<LoweredCleanup>(),
    liveFlag: "",
    labels: Array<String>(),
    matchConsumesSubject: false,
    matchBindingNeedsCleanup: false,
  }));
  outputSegments = move segments;
  outputRoots = move segmentRoots;
}

function lowerMainDelayLoop(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in declaration: FunctionDeclaration,
  in parameters: Array<LoweredParameter>,
  sourceLoop: usize,
  prefixRoots: Array<usize>,
  inout expressions: Array<LoweredExpression>,
  inout statements: Array<LoweredStatement>
): LoweredMainDelayLoop throws String {
  if (
    declaration.body.nodes[sourceLoop].kind != StatementKind.whileStatement
    || declaration.body.nodes[sourceLoop].children.length != 1
  ) throw `native lowering received a malformed suspending while in ${declaration.name}`;
  if (statementExpressionContainsTry(declaration.body, sourceLoop)) {
    throw `native lowering does not yet preserve a throwing while condition across suspension in ${declaration.name}`;
  }
  let parameterIndex: usize = 0;
  while (parameterIndex < declaration.parameters.length) {
    const parameter = view declaration.parameters[parameterIndex];
    if (statementTreeWritesName(
      program,
      evidence,
      declaration.body,
      sourceLoop,
      parameter.name
    )) {
      throw `native lowering does not yet preserve writes to parameter ${parameter.name} through a suspending while in ${declaration.name}`;
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
        declaration.body.nodes[sourceLoop],
        parameter.name
      )
    ) {
      throw `native lowering does not yet preserve ownership transfer of parameter ${parameter.name} through a suspending while in ${declaration.name}`;
    }
    parameterIndex = parameterIndex + 1;
  }
  let condition: usize = 0;
  match (in declaration.body.nodes[sourceLoop].expression) {
    some(source) => match (in source.tree) {
      some(tree) => {
        const root = tree.root;
        condition = try lowerExpression(
          program,
          importedTypes,
          evidence,
          tree,
          root,
          inout expressions
        );
      }
      none => throw "native lowering cannot lower an opaque while condition";
    }
    none => throw "native lowering received a while without a condition";
  }
  const sourceBlock = declaration.body.nodes[sourceLoop].children[0];
  let block: usize = 0;
  let segments = Array<LoweredMainDelaySegment>();
  let roots = Array<usize>();
  try lowerMainDelayLoopBody(
    program,
    importedTypes,
    evidence,
    declaration,
    parameters,
    sourceBlock,
    prefixRoots,
    inout expressions,
    inout statements,
    inout block,
    inout segments,
    inout roots
  );
  let children = Array<usize>();
  children.push(block);
  const statement = statements.length;
  statements.push(LoweredStatement({
    kind: LoweredStatementKind.whileStatement,
    mutableBinding: false,
    name: "",
    type: Option<LoweredType>.none,
    expression: Option.some(condition),
    secondExpression: Option<usize>.none,
    children,
    cleanups: Array<LoweredCleanup>(),
    liveFlag: "",
    labels: Array<String>(),
    matchConsumesSubject: false,
    matchBindingNeedsCleanup: false,
  }));
  return LoweredMainDelayLoop({
    statement,
    prefixRoots: move prefixRoots,
    condition,
    block,
    segments,
    roots,
  });
}

function lowerMainDelayMatchTree(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in declaration: FunctionDeclaration,
  in parameters: Array<LoweredParameter>,
  prefixRoots: Array<usize>,
  in tree: ExpressionTree,
  inout expressions: Array<LoweredExpression>,
  inout statements: Array<LoweredStatement>
): LoweredMainDelayMatch throws String {
  const root = tree.root;
  if (
    tree.nodes[root].kind != ExpressionKind.matchExpression
    || tree.nodes[root].children.length < 2
  ) throw `native lowering received a malformed suspending match in ${declaration.name}`;
  const enumDeclaration = try matchEnumDeclaration(
    program,
    importedTypes,
    evidence,
    declaration.body,
    declaration.name,
    tree,
    root
  );
  const subjectType = LoweredType({
    kind: LoweredTypeKind.enumType,
    name: enumDeclaration.name.copyBytes(
      0,
      enumDeclaration.name.byteLength
    ),
  });
  const subjectNeedsCleanup = moduleTypeNeedsCleanup(
    program,
    importedTypes,
    subjectType
  );
  const consuming = tree.nodes[root].value != "in";
  const subjectInput = tree.nodes[root].children[0];
  if (subjectNeedsCleanup && !consuming) {
    throw `native lowering requires a consuming match for cleanup-bearing suspended subject in ${declaration.name}; omit in so the invocation frame can own the selected payload`;
  }
  let parameterIndex: usize = 0;
  while (parameterIndex < declaration.parameters.length) {
    let subjectTransfersParameter = false;
    if (subjectNeedsCleanup && consuming) {
      if (
        tree.nodes[subjectInput].kind
          == ExpressionKind.identifierExpression
        && tree.nodes[subjectInput].value
          == declaration.parameters[parameterIndex].name
      ) subjectTransfersParameter = true;
      else subjectTransfersParameter = treeMovesName(
        program,
        evidence,
        tree,
        subjectInput,
        declaration.parameters[parameterIndex].name
      );
    }
    if (
      moduleTypeNeedsCleanup(
        program,
        importedTypes,
        parameters[parameterIndex].type
      )
      && treeMovesName(
        program,
        evidence,
        tree,
        root,
        declaration.parameters[parameterIndex].name
      )
      && !subjectTransfersParameter
    ) {
      throw `native lowering does not yet preserve ownership transfer of parameter ${declaration.parameters[parameterIndex].name} through a suspending match subject in ${declaration.name}`;
    }
    parameterIndex = parameterIndex + 1;
  }
  const subject = try lowerExpression(
    program,
    importedTypes,
    evidence,
    tree,
    subjectInput,
    inout expressions
  );
  let loweredArms = Array<usize>();
  let plans = Array<LoweredMainDelayMatchArm>();
  let delayCount: usize = 0;
  let armPosition: usize = 1;
  while (armPosition < tree.nodes[root].children.length) {
    const sourceArm = tree.nodes[root].children[armPosition];
    if (
      tree.nodes[sourceArm].kind != ExpressionKind.matchArmExpression
      || tree.nodes[sourceArm].statements.length != 1
    ) {
      throw `native lowering requires one braced body for every arm of a suspending match in ${declaration.name}`;
    }
    let payloadType = Option<LoweredType>.none;
    for (const variant of enumDeclaration.variants) {
      if (variant.name != tree.nodes[sourceArm].value) continue;
      match (in variant.payload) {
        some(type) => payloadType = Option.some(LoweredType({
          kind: type.kind,
          name: type.name.copyBytes(0, type.name.byteLength),
        }));
        none => {}
      }
    }
    let sourcePayloadBinding = "";
    let emittedPayloadBinding = "";
    let payloadLiveFlag = "";
    let labels = Array<String>();
    match (in payloadType) {
      some(type) => {
        if (
          tree.nodes[sourceArm].children.length != 1
          || tree.nodes[tree.nodes[sourceArm].children[0]].kind
            != ExpressionKind.matchBindingExpression
        ) {
          throw `native lowering requires one direct payload binding in every payload-bearing arm of a suspending match in ${declaration.name}`;
        }
        const binding = tree.nodes[sourceArm].children[0];
        sourcePayloadBinding = tree.nodes[binding].value.copyBytes(
          0,
          tree.nodes[binding].value.byteLength
        );
        emittedPayloadBinding =
          `_z_stage1_match_payload_${expressions.length}_${armPosition}`;
        labels.push(emittedPayloadBinding.copyBytes(
          0,
          emittedPayloadBinding.byteLength
        ));
        if (
          consuming
          && moduleTypeNeedsCleanup(program, importedTypes, type)
        ) payloadLiveFlag = ownerLiveFlag(emittedPayloadBinding);
      }
      none => {
        if (tree.nodes[sourceArm].children.length > 0) {
          throw `native lowering received a payload binding for payload-free arm ${tree.nodes[sourceArm].value} in ${declaration.name}`;
        }
      }
    }
    const sourceBlock = tree.nodes[sourceArm].statements[0];
    const armExpressionStart = expressions.length;
    const armStatementStart = statements.length;
    let block: usize = 0;
    let segments = Array<LoweredMainDelaySegment>();
    let roots = Array<usize>();
    try lowerMainDelayBranch(
      program,
      importedTypes,
      evidence,
      declaration,
      parameters,
      sourceBlock,
      prefixRoots,
      inout expressions,
      inout statements,
      inout block,
      inout segments,
      inout roots
    );
    rewriteLoweredMatchPayloadBinding(
      inout expressions,
      statements,
      armExpressionStart,
      armStatementStart,
      sourcePayloadBinding,
      emittedPayloadBinding
    );
    delayCount = delayCount + segments.length;
    let armChildren = Array<usize>();
    armChildren.push(block);
    const payloadNeedsCleanup = payloadLiveFlag.byteLength > 0;
    const arm = statements.length;
    statements.push(LoweredStatement({
      kind: LoweredStatementKind.matchArmStatement,
      mutableBinding: false,
      name: tree.nodes[sourceArm].value.copyBytes(
        0,
        tree.nodes[sourceArm].value.byteLength
      ),
      type: payloadType,
      expression: Option<usize>.none,
      secondExpression: Option<usize>.none,
      children: move armChildren,
      cleanups: Array<LoweredCleanup>(),
      liveFlag: move payloadLiveFlag,
      labels,
      matchConsumesSubject: false,
      matchBindingNeedsCleanup: payloadNeedsCleanup,
    }));
    loweredArms.push(arm);
    plans.push(LoweredMainDelayMatchArm({
      arm,
      block,
      segments,
      roots,
    }));
    armPosition = armPosition + 1;
  }
  if (delayCount == 0) {
    throw `native lowering lost every delay inside the suspending match in ${declaration.name}`;
  }
  let matchLabels = Array<String>();
  if (enumDeclaration.payloadBearing) matchLabels.push("tagged");
  if (
    tree.nodes[subjectInput].kind != ExpressionKind.identifierExpression
  ) matchLabels.push("computed-subject");
  const statement = statements.length;
  statements.push(LoweredStatement({
    kind: LoweredStatementKind.matchStatement,
    mutableBinding: false,
    name: enumDeclaration.name.copyBytes(
      0,
      enumDeclaration.name.byteLength
    ),
    type: Option.some(LoweredType({
      kind: subjectType.kind,
      name: subjectType.name.copyBytes(0, subjectType.name.byteLength),
    })),
    expression: Option.some(subject),
    secondExpression: Option<usize>.none,
    children: loweredArms,
    cleanups: Array<LoweredCleanup>(),
    liveFlag: "",
    labels: move matchLabels,
    matchConsumesSubject: consuming,
    matchBindingNeedsCleanup: false,
  }));
  return LoweredMainDelayMatch({
    statement,
    prefixRoots: move prefixRoots,
    subject,
    subjectType,
    arms: move plans,
  });
}

function lowerMainDelayMatch(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in declaration: FunctionDeclaration,
  in parameters: Array<LoweredParameter>,
  sourceMatch: usize,
  prefixRoots: Array<usize>,
  inout expressions: Array<LoweredExpression>,
  inout statements: Array<LoweredStatement>
): LoweredMainDelayMatch throws String {
  if (declaration.body.nodes[sourceMatch].kind != StatementKind.matchStatement) {
    throw `native lowering received a malformed suspending match in ${declaration.name}`;
  }
  match (in declaration.body.nodes[sourceMatch].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => return try lowerMainDelayMatchTree(
        program,
        importedTypes,
        evidence,
        declaration,
        parameters,
        move prefixRoots,
        tree,
        inout expressions,
        inout statements
      );
      none => throw "native lowering cannot lower an opaque match";
    }
    none => throw "native lowering received a match without a subject";
  }
}

function ensureMainFrameLocalLiveFlags(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in roots: Array<usize>,
  inout statements: Array<LoweredStatement>,
  inout liveFlags: Array<LoweredLiveFlag>
): void {
  const resultPrefix = "__z_Result_";
  for (const root of roots) {
    if (
      statements[root].kind != LoweredStatementKind.localStatement
      || statements[root].liveFlag.byteLength > 0
    ) continue;
    const frameLocalNeedsCleanup = match (in statements[root].type) {
      some(type) => moduleTypeNeedsCleanup(program, importedTypes, type)
        || (
          type.kind == LoweredTypeKind.enumType
          && type.name.byteLength >= resultPrefix.byteLength
          && type.name.copyBytes(0, resultPrefix.byteLength)
            == resultPrefix
        );
      none => false;
    };
    if (!frameLocalNeedsCleanup) continue;
    const guard = ownerLiveFlag(statements[root].name);
    statements[root].liveFlag = guard.copyBytes(0, guard.byteLength);
    liveFlags.push(LoweredLiveFlag({
      owner: statements[root].name.copyBytes(
        0,
        statements[root].name.byteLength
      ),
      name: move guard,
      parameter: false,
    }));
  }
}

function lowerFunction(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in declaration: FunctionDeclaration,
  in semanticOwnerName: String,
  in sourcePath: String,
  in receiverName: String,
  receiverKind: LoweredTypeKind,
  receiverSourceMode: ReceiverMode
): LoweredFunction throws String {
  let delayCount: usize = 0;
  let lastDelayPosition: usize = 0;
  let hasMainDelayIf = false;
  let mainDelayIfSource: usize = 0;
  let mainDelayIfPosition: usize = 0;
  let hasMainDelayMatch = false;
  let mainDelayMatchSource: usize = 0;
  let mainDelayMatchPosition: usize = 0;
  let hasMainDelayLoop = false;
  let mainDelayLoopSource: usize = 0;
  let mainDelayLoopPosition: usize = 0;
  let asyncSuspension = "";
  if (declaration.asynchronous && declaration.name != "main") {
    const firstTierSchedulerYield = declaration.executorAffinity != "thread.main"
      && functionUsesFirstTierSchedulerYield(program, declaration);
    const firstTierDoubleAwait = receiverName.byteLength == 0
      && functionUsesFirstTierDoubleAwait(declaration);
    const firstTierPlacedFunctionLinear = declaration.executorAffinity
        != "thread.main"
      && functionUsesFirstTierPlacedFunctionLinearAwait(declaration);
    const firstTierPlacedMethodLinear = declaration.executorAffinity
        != "thread.main"
      && functionUsesFirstTierPlacedMethodLinearAwait(declaration);
    const firstTierLinearAwait = functionUsesFirstTierLinearAwait(declaration)
      || firstTierPlacedFunctionLinear
      || firstTierPlacedMethodLinear;
    const firstTierPlacedMethodTail = declaration.executorAffinity
        != "thread.main"
      && functionUsesFirstTierPlacedMethodTailAwait(declaration);
    const firstTierPlacedFunctionTail = declaration.executorAffinity
        != "thread.main"
      && functionUsesFirstTierPlacedFunctionTailAwait(declaration);
    const firstTierTailAwait = (
        declaration.executorAffinity != "thread.main"
        && (
        functionUsesFirstTierTailAwait(declaration)
        || firstTierPlacedMethodTail
        || firstTierPlacedFunctionTail
        || functionUsesFirstTierPrefixedTailAwait(declaration)
        || functionUsesFirstTierMatchedTailAwait(declaration)
        || firstTierLinearAwait
        || firstTierDoubleAwait
      )
      ) || (
        declaration.executorAffinity == "thread.main"
        && !functionContainsMainDelayAwait(program, declaration)
        && (
          functionUsesFirstTierTailAwait(declaration)
          || functionUsesFirstTierPrefixedTailAwait(declaration)
          || functionUsesFirstTierMatchedTailAwait(declaration)
          || firstTierLinearAwait
          || firstTierDoubleAwait
        )
      );
    if (
      declaration.executorAffinity != "thread.main"
      && functionContainsSuspension(declaration)
      && !firstTierSchedulerYield
      && !firstTierTailAwait
    ) {
      throw `native lowering does not support suspending async function ${declaration.name} yet`;
    }
    if (firstTierSchedulerYield) asyncSuspension = "scheduler-yield";
    else if (firstTierTailAwait) {
      if (firstTierDoubleAwait) {
        asyncSuspension = "double-await";
      } else asyncSuspension = firstTierLinearAwait
          ? "linear-await"
          : "tail-await";
    }
    let position: usize = 0;
    while (
      declaration.executorAffinity == "thread.main"
      && asyncSuspension.byteLength == 0
      && position < declaration.body.roots.length
    ) {
      const root = declaration.body.roots[position];
      if (statementIsTaskScopeJoinAwait(
        program,
        importedTypes,
        evidence,
        declaration.body,
        root
      )) {
        position = position + 1;
        continue;
      }
      if (
        statementContainsSuspension(declaration.body, root)
        && declaration.body.nodes[root].kind == StatementKind.whileStatement
      ) {
        if (
          hasMainDelayIf
          || hasMainDelayMatch
          || hasMainDelayLoop
          || delayCount > 0
        ) {
          throw `native lowering supports one top-level suspending if, match, while, or one linear delay sequence in ${declaration.name}`;
        }
        hasMainDelayLoop = true;
        mainDelayLoopSource = root;
        mainDelayLoopPosition = position;
        position = position + 1;
        continue;
      }
      if (
        statementContainsSuspension(declaration.body, root)
        && declaration.body.nodes[root].kind == StatementKind.ifStatement
      ) {
        if (
          hasMainDelayIf
          || hasMainDelayMatch
          || hasMainDelayLoop
          || delayCount > 0
        ) {
          throw `native lowering supports one top-level suspending if, match, while, or one linear delay sequence in ${declaration.name}`;
        }
        hasMainDelayIf = true;
        mainDelayIfSource = root;
        mainDelayIfPosition = position;
        let branchDelayCount: usize = 0;
        for (const sourceBranch of declaration.body.nodes[root].children) {
          if (
            declaration.body.nodes[sourceBranch].kind
              != StatementKind.blockStatement
          ) {
            throw `native lowering requires braced branches when if contains suspension in ${declaration.name}`;
          }
          for (const sourceChild of declaration.body.nodes[sourceBranch].children) {
            if (!statementContainsSuspension(declaration.body, sourceChild)) {
              continue;
            }
            const branchDelay = try mainDelayMillisecondsAtStatement(
              program,
              declaration.body,
              semanticOwnerName,
              sourceChild
            );
            if (branchDelay.byteLength > 0) {
              branchDelayCount = branchDelayCount + 1;
            }
          }
        }
        if (branchDelayCount == 0) {
          throw `native lowering lost every delay inside the suspending if in ${declaration.name}`;
        }
        position = position + 1;
        continue;
      }
      if (
        statementContainsSuspension(declaration.body, root)
        && declaration.body.nodes[root].kind == StatementKind.matchStatement
      ) {
        if (
          hasMainDelayIf
          || hasMainDelayMatch
          || hasMainDelayLoop
          || delayCount > 0
        ) {
          throw `native lowering supports one top-level suspending if, match, while, or one linear delay sequence in ${declaration.name}`;
        }
        hasMainDelayMatch = true;
        mainDelayMatchSource = root;
        mainDelayMatchPosition = position;
        position = position + 1;
        continue;
      }
      if (
        (hasMainDelayIf || hasMainDelayMatch || hasMainDelayLoop)
        && statementContainsSuspension(declaration.body, root)
      ) {
        throw `native lowering supports one top-level suspending if, match, while, or one linear delay sequence in ${declaration.name}`;
      }
      const delay = try mainDelayMillisecondsAtStatement(
        program,
        declaration.body,
        semanticOwnerName,
        root
      );
      if (delay.byteLength > 0) {
        if (hasMainDelayIf || hasMainDelayMatch || hasMainDelayLoop) {
          throw `native lowering supports one top-level suspending if, match, while, or one linear delay sequence in ${declaration.name}`;
        }
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
  if (asyncSuspension == "scheduler-yield") {
    if (receiverName.byteLength == 0) {
      for (const parameter of parameters) {
        if (
          parameter.mode != LoweredParameterMode.value
          || moduleTypeNeedsCleanup(program, importedTypes, parameter.type)
        ) {
          throw `native scheduler.yield function ${declaration.name} requires cleanup-free value parameters in the first tier`;
        }
      }
      const yieldReturnType = try lowerModuleType(
        program,
        importedTypes,
        declaration.returnType
      );
      if (moduleTypeNeedsCleanup(
        program,
        importedTypes,
        yieldReturnType
      )) {
        throw `native scheduler.yield function ${declaration.name} requires a cleanup-free result in the first tier`;
      }
    } else {
      if (
        receiverKind != LoweredTypeKind.classType
        || receiverSourceMode != ReceiverMode.none
      ) {
        throw `native scheduler.yield method ${receiverName}.${declaration.name} requires a non-consuming class receiver in the first tier`;
      }
      for (const parameter of parameters) {
        if (
          parameter.mode != LoweredParameterMode.input
          && (
            parameter.mode != LoweredParameterMode.value
            || moduleTypeNeedsCleanup(
              program,
              importedTypes,
              parameter.type
            )
          )
        ) {
          throw `native scheduler.yield method ${receiverName}.${declaration.name} requires borrowed or cleanup-free value parameters in the first tier`;
        }
      }
    }
  }
  let expressions = Array<LoweredExpression>();
  let statements = Array<LoweredStatement>();
  let sourceRoots = Array<usize>();
  let planningRoots = Array<usize>();
  let segmentRoots = Array<usize>();
  let mainDelaySegments = Array<LoweredMainDelaySegment>();
  let mainDelayIfs = Array<LoweredMainDelayIf>();
  let mainDelayMatches = Array<LoweredMainDelayMatch>();
  let mainDelayLoops = Array<LoweredMainDelayLoop>();
  const linearPrefixRoots = Array<usize>();
  let rootPosition: usize = 0;
  for (const root of declaration.body.roots) {
    if (
      asyncSuspension == "scheduler-yield"
      && rootPosition == 0
    ) {
      rootPosition = rootPosition + 1;
      continue;
    }
    if (hasMainDelayIf && rootPosition == mainDelayIfPosition) {
      sourceRoots.push(root);
      const mainDelayIf = try lowerMainDelayIf(
        program,
        importedTypes,
        evidence,
        declaration,
        parameters,
        mainDelayIfSource,
        move segmentRoots,
        inout expressions,
        inout statements
      );
      planningRoots.push(mainDelayIf.statement);
      mainDelayIfs.push(move mainDelayIf);
      segmentRoots = Array<usize>();
      rootPosition = rootPosition + 1;
      continue;
    }
    if (hasMainDelayMatch && rootPosition == mainDelayMatchPosition) {
      sourceRoots.push(root);
      const mainDelayMatch = try lowerMainDelayMatch(
        program,
        importedTypes,
        evidence,
        declaration,
        parameters,
        mainDelayMatchSource,
        move segmentRoots,
        inout expressions,
        inout statements
      );
      planningRoots.push(mainDelayMatch.statement);
      mainDelayMatches.push(move mainDelayMatch);
      segmentRoots = Array<usize>();
      rootPosition = rootPosition + 1;
      continue;
    }
    if (hasMainDelayLoop && rootPosition == mainDelayLoopPosition) {
      sourceRoots.push(root);
      const mainDelayLoop = try lowerMainDelayLoop(
        program,
        importedTypes,
        evidence,
        declaration,
        parameters,
        mainDelayLoopSource,
        move segmentRoots,
        inout expressions,
        inout statements
      );
      planningRoots.push(mainDelayLoop.statement);
      mainDelayLoops.push(move mainDelayLoop);
      segmentRoots = Array<usize>();
      rootPosition = rootPosition + 1;
      continue;
    }
    let delay = "";
    if (delayCount > 0) {
      delay = try mainDelayMillisecondsAtStatement(
        program,
        declaration.body,
        semanticOwnerName,
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
    const beforeSuspension = (
      delayCount > 0 && rootPosition < lastDelayPosition
    ) || (
      hasMainDelayIf && rootPosition < mainDelayIfPosition
    ) || (
      hasMainDelayMatch && rootPosition < mainDelayMatchPosition
    ) || (
      hasMainDelayLoop && rootPosition < mainDelayLoopPosition
    );
    if (beforeSuspension) {
      try validateMainFrameSourceStatement(
        program,
        importedTypes,
        evidence,
        declaration,
        parameters,
        root,
        false
      );
    }
    sourceRoots.push(root);
    const loweredRootOutcome = attempt lowerStatement(
      program,
      importedTypes,
      evidence,
      declaration.body,
      semanticOwnerName,
      root,
      inout expressions,
      inout statements
    );
    const loweredRoot = match (loweredRootOutcome) {
      success(value) => value;
      failure(message) => throw
        `${message} while lowering statement at ${declaration.body.nodes[root].line}:${declaration.body.nodes[root].column}`;
    };
    if (beforeSuspension) {
      try validateMainFrameLoweredStatement(
        program,
        importedTypes,
        declaration,
        parameters,
        expressions,
        statements,
        linearPrefixRoots,
        mainDelaySegments,
        segmentRoots,
        loweredRoot,
        false
      );
    }
    planningRoots.push(loweredRoot);
    segmentRoots.push(loweredRoot);
    rootPosition = rootPosition + 1;
  }
  const roots = move segmentRoots;
  try rewritePlacedFunctionAwaits(
    program,
    importedTypes,
    evidence,
    declaration,
    roots,
    inout expressions,
    inout statements
  );
  const functionMoveIndex = cleanupMoveIndex(
    program,
    evidence,
    declaration.body,
    expressions
  );
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
      const moved = cleanupIndexMovesBinding(
        functionMoveIndex,
        parameterName,
        parameterOffset
      );
      let guard = "";
      if (
        moved
        && (
          declaration.asynchronous
          ||
          hasMainDelayMatch
          || hasMainDelayLoop
          || functionMoveIndex.hasControlFlow
        )
      ) {
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
  if (
    receiverName.byteLength > 0
    && receiverSourceMode == ReceiverMode.move
  ) {
    const receiverType = LoweredType({
      kind: receiverKind,
      name: receiverName.copyBytes(0, receiverName.byteLength),
    });
    if (moduleTypeNeedsCleanup(program, importedTypes, receiverType)) {
      const guard = ownerLiveFlag("this");
      liveFlags.push(LoweredLiveFlag({
        owner: "this",
        name: guard.copyBytes(0, guard.byteLength),
        parameter: true,
      }));
      ownedParameters.push(LoweredCleanup({
        name: "self",
        type: move receiverType,
        guard,
      }));
    }
  }
  if (
    (
      asyncSuspension == "tail-await"
      || asyncSuspension == "linear-await"
      || asyncSuspension == "double-await"
    )
    && roots.length > 1
  ) {
    ensureMainFrameLocalLiveFlags(
      program,
      importedTypes,
      roots,
      inout statements,
      inout liveFlags
    );
  }
  const rootLoopCleanups = Array<LoweredCleanup>();
  const introduced = try planCleanupSequence(
    program,
    importedTypes,
    evidence,
    declaration.body,
    semanticOwnerName,
    sourceRoots,
    planningRoots,
    ownedParameters,
    expressions,
    functionMoveIndex,
    inout statements,
    inout liveFlags,
    hasMainDelayMatch || hasMainDelayLoop,
    false,
    rootLoopCleanups
  );
  for (const segment of mainDelaySegments) {
    ensureMainFrameLocalLiveFlags(
      program,
      importedTypes,
      segment.roots,
      inout statements,
      inout liveFlags
    );
  }
  for (const plan of mainDelayIfs) {
    ensureMainFrameLocalLiveFlags(
      program,
      importedTypes,
      plan.prefixRoots,
      inout statements,
      inout liveFlags
    );
    for (const segment of plan.thenSegments) {
      ensureMainFrameLocalLiveFlags(
        program,
        importedTypes,
        segment.roots,
        inout statements,
        inout liveFlags
      );
    }
    for (const segment of plan.elseSegments) {
      ensureMainFrameLocalLiveFlags(
        program,
        importedTypes,
        segment.roots,
        inout statements,
        inout liveFlags
      );
    }
  }
  for (const plan of mainDelayMatches) {
    ensureMainFrameLocalLiveFlags(
      program,
      importedTypes,
      plan.prefixRoots,
      inout statements,
      inout liveFlags
    );
    for (const arm of plan.arms) {
      const armStatement = view statements[arm.arm];
      if (armStatement.liveFlag.byteLength > 0) {
        liveFlags.push(LoweredLiveFlag({
          owner: armStatement.labels[0].copyBytes(
            0,
            armStatement.labels[0].byteLength
          ),
          name: armStatement.liveFlag.copyBytes(
            0,
            armStatement.liveFlag.byteLength
          ),
          parameter: false,
        }));
      }
      for (const segment of arm.segments) {
        ensureMainFrameLocalLiveFlags(
          program,
          importedTypes,
          segment.roots,
          inout statements,
          inout liveFlags
        );
      }
    }
  }
  for (const plan of mainDelayLoops) {
    ensureMainFrameLocalLiveFlags(
      program,
      importedTypes,
      plan.prefixRoots,
      inout statements,
      inout liveFlags
    );
    for (const segment of plan.segments) {
      ensureMainFrameLocalLiveFlags(
        program,
        importedTypes,
        segment.roots,
        inout statements,
        inout liveFlags
      );
    }
  }
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
    semanticOwnerName
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
  let loweredReceiverType = Option<LoweredType>.none;
  if (receiverName.byteLength > 0) {
    loweredReceiverType = Option.some(LoweredType({
      kind: receiverKind,
      name: receiverName.copyBytes(0, receiverName.byteLength),
    }));
  }
  return LoweredFunction({
    name: declaration.name.copyBytes(0, declaration.name.byteLength),
    testName: declaration.testName.copyBytes(0, declaration.testName.byteLength),
    sourcePath: sourcePath.copyBytes(0, sourcePath.byteLength),
    nativeCExportName: declaration.nativeCExport
      ? declaration.name.copyBytes(0, declaration.name.byteLength)
      : "",
    compilerIntrinsic: "",
    compilerIntrinsicType: Option<LoweredType>.none,
    rawLanguage: declaration.rawLanguage.copyBytes(
      0,
      declaration.rawLanguage.byteLength
    ),
    rawSource: declaration.rawSource.copyBytes(
      0,
      declaration.rawSource.byteLength
    ),
    rawLine: declaration.rawLine,
    rawColumn: declaration.rawColumn,
    asynchronous: declaration.asynchronous,
    asyncSuspension: move asyncSuspension,
    mainDelaySegments,
    mainDelayIfs,
    mainDelayMatches,
    mainDelayLoops,
    receiverType: move loweredReceiverType,
    receiverMode: lowerReceiverMode(receiverSourceMode),
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
  const deinitializerMoveIndex = cleanupMoveIndex(
    program,
    evidence,
    body,
    expressions
  );
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
    deinitializerMoveIndex,
    inout statements,
    inout liveFlags,
    false,
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
    compilerIntrinsic: "",
    compilerIntrinsicType: Option<LoweredType>.none,
    asynchronous: false,
    asyncSuspension: "",
    mainDelaySegments: Array<LoweredMainDelaySegment>(),
    mainDelayIfs: Array<LoweredMainDelayIf>(),
    mainDelayMatches: Array<LoweredMainDelayMatch>(),
    mainDelayLoops: Array<LoweredMainDelayLoop>(),
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

function lowerConstructor(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in sourcePath: String,
  in sourceOwnerName: String,
  in emittedOwnerName: String,
  in declaration: ConstructorDeclaration
): LoweredFunction throws String {
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

  const ownerName = `${sourceOwnerName}.constructor`;
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
      ownerName,
      root,
      inout expressions,
      inout statements
    );
    roots.push(loweredRoot);
  }

  const moveIndex = cleanupMoveIndex(
    program,
    evidence,
    declaration.body,
    expressions
  );
  let parameterIndex: usize = 0;
  while (parameterIndex < declaration.parameters.length) {
    const parameter = view declaration.parameters[parameterIndex];
    const parameterType = view parameters[parameterIndex].type;
    if (
      parameter.mode == ParameterMode.value
      && moduleTypeNeedsCleanup(program, importedTypes, parameterType)
    ) {
      const moved = cleanupIndexMovesBinding(
        moveIndex,
        parameter.name,
        parameter.offset
      );
      let guard = "";
      if (moved && moveIndex.hasControlFlow) {
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
            name: parameterType.name.copyBytes(
              0,
              parameterType.name.byteLength
            ),
          }),
          guard: move guard,
        }));
      }
    }
    parameterIndex = parameterIndex + 1;
  }

  const loopCleanups = Array<LoweredCleanup>();
  const introduced = try planCleanupSequence(
    program,
    importedTypes,
    evidence,
    declaration.body,
    ownerName,
    sourceRoots,
    roots,
    ownedParameters,
    expressions,
    moveIndex,
    inout statements,
    inout liveFlags,
    false,
    false,
    loopCleanups
  );
  let fallthroughCleanups = Array<LoweredCleanup>();
  appendCleanupCopies(inout fallthroughCleanups, ownedParameters);
  appendCleanupCopies(inout fallthroughCleanups, introduced);
  attachMoveLiveFlags(inout expressions, liveFlags);
  rewriteParameterValues(parameters, inout expressions);

  return LoweredFunction({
    name: `Z_${emittedOwnerName}___constructor`,
    testName: "",
    sourcePath: sourcePath.copyBytes(0, sourcePath.byteLength),
    nativeCExportName: "",
    compilerIntrinsic: "classConstructor",
    compilerIntrinsicType: Option<LoweredType>.none,
    asynchronous: false,
    asyncSuspension: "",
    mainDelaySegments: Array<LoweredMainDelaySegment>(),
    mainDelayIfs: Array<LoweredMainDelayIf>(),
    mainDelayMatches: Array<LoweredMainDelayMatch>(),
    mainDelayLoops: Array<LoweredMainDelayLoop>(),
    receiverType: Option.some(LoweredType({
      kind: LoweredTypeKind.classType,
      name: emittedOwnerName.copyBytes(0, emittedOwnerName.byteLength),
    })),
    receiverMode: LoweredParameterMode.inputOutput,
    parameters,
    returnType: LoweredType({
      kind: LoweredTypeKind.voidType,
      name: "",
    }),
    fallthroughExpression: Option<usize>.none,
    expressions,
    statements,
    roots,
    fallthroughCleanups,
    liveFlags,
  });
}

function lowerGenericFieldDefault(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in sourcePath: String,
  in targetName: String,
  in field: FieldDeclaration
): LoweredFunction throws String {
  match (in field.defaultValue) {
    some(expression) => match (in expression.tree) {
      some(tree) => {
        let expressions = Array<LoweredExpression>();
        const root = tree.root;
        let value = try lowerExpressionExpected(
          program,
          importedTypes,
          evidence,
          tree,
          root,
          field.type.name,
          inout expressions
        );
        value = wrapImplicitOwnedTransfer(
          tree,
          root,
          value,
          inout expressions
        );
        const returnType = try lowerModuleType(
          program,
          importedTypes,
          field.type
        );
        return LoweredFunction({
          name: targetName.copyBytes(0, targetName.byteLength),
          testName: "",
          sourcePath: sourcePath.copyBytes(0, sourcePath.byteLength),
          nativeCExportName: "",
          compilerIntrinsic: "",
          compilerIntrinsicType: Option<LoweredType>.none,
          asynchronous: false,
          asyncSuspension: "",
          mainDelaySegments: Array<LoweredMainDelaySegment>(),
          mainDelayIfs: Array<LoweredMainDelayIf>(),
          mainDelayMatches: Array<LoweredMainDelayMatch>(),
          mainDelayLoops: Array<LoweredMainDelayLoop>(),
          receiverType: Option<LoweredType>.none,
          receiverMode: LoweredParameterMode.value,
          parameters: Array<LoweredParameter>(),
          returnType,
          fallthroughExpression: Option.some(value),
          expressions,
          statements: Array<LoweredStatement>(),
          roots: Array<usize>(),
          fallthroughCleanups: Array<LoweredCleanup>(),
          liveFlags: Array<LoweredLiveFlag>(),
        });
      }
      none => throw `native generic default helper could not project ${field.name}`;
    }
    none => throw `native generic default helper lost ${field.name}`;
  }
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

function containsLoweredFixedArray(
  in arrays: Array<LoweredFixedArray>,
  in name: String
): boolean {
  for (const declaration of arrays) {
    if (declaration.name == name) return true;
  }
  return false;
}

function containsLoweredSlice(
  in slices: Array<LoweredSlice>,
  in name: String
): boolean {
  for (const declaration of slices) {
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
      lowered.expressions[index].kind
        == LoweredExpressionKind.directFunctionValue
    ) {
      for (const declaration of program.functions) {
        if (
          declaration.name == lowered.expressions[index].value
          && privateFunctionNeedsMangle(
            program,
            collisionNames,
            moduleIndex,
            entryIndex,
            declaration.name
          )
        ) {
          lowered.expressions[index].value = emittedPrivateFunctionName(
            moduleIndex,
            declaration.name
          );
        }
      }
    }
    if (
      lowered.expressions[index].kind == LoweredExpressionKind.directCall
      && lowered.expressions[index].children.length > 0
    ) {
      const callee = lowered.expressions[index].children[0];
      if (
        lowered.expressions[callee].kind == LoweredExpressionKind.localValue
      ) {
        for (const declaration of program.functions) {
          const genericTarget = `${declaration.name}__Function_`;
          if (
            (
              declaration.name == lowered.expressions[callee].value
              || stringStartsWith(
                lowered.expressions[callee].value,
                genericTarget
              )
            )
            && privateFunctionNeedsMangle(
              program,
              collisionNames,
              moduleIndex,
              entryIndex,
              declaration.name
            )
          ) {
            const suffix = lowered.expressions[callee].value.copyBytes(
              declaration.name.byteLength,
              lowered.expressions[callee].value.byteLength
            );
            const privateName = emittedPrivateFunctionName(
              moduleIndex,
              declaration.name
            );
            lowered.expressions[callee] = LoweredExpression({
              kind: LoweredExpressionKind.localValue,
              value: `${privateName}${suffix}`,
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
  inout fixedArrays: Array<LoweredFixedArray>,
  inout arrays: Array<LoweredArray>,
  inout slices: Array<LoweredSlice>,
  inout maps: Array<LoweredMap>,
  inout sets: Array<LoweredSet>,
  inout enums: Array<LoweredEnum>
): void throws String {
  for (const aggregate of program.aggregates) {
    for (const parameter of aggregate.typeParameters) {
      if (
        typeContainsNamedGenericParameter(name, parameter.name)
        && !genericParameterHasNominalShadow(
          program,
          importedTypes,
          parameter.name
        )
      ) return;
    }
    for (const method of aggregate.methods) {
      for (const parameter of method.typeParameters) {
        if (
          typeContainsNamedGenericParameter(name, parameter.name)
          && !genericParameterHasNominalShadow(
            program,
            importedTypes,
            parameter.name
          )
        ) return;
      }
    }
  }
  for (const declaration of program.functions) {
    for (const parameter of declaration.typeParameters) {
      if (
        typeContainsNamedGenericParameter(name, parameter.name)
        && !genericParameterHasNominalShadow(
          program,
          importedTypes,
          parameter.name
        )
      ) return;
    }
  }
  const fixedArray = try intrinsicFixedArrayDeclaration(
    program,
    importedTypes,
    name
  );
  match (fixedArray) {
    some(declaration) => {
      match (fixedArrayShape(name)) {
        some(shape) => try collectIntrinsicTypeName(
          program,
          importedTypes,
          shape.elementType,
          inout fixedArrays,
          inout arrays,
          inout slices,
          inout maps,
          inout sets,
          inout enums
        );
        none => {}
      }
      if (!containsLoweredSlice(slices, declaration.sliceName)) {
        slices.push(LoweredSlice({
          name: declaration.sliceName.copyBytes(
            0,
            declaration.sliceName.byteLength
          ),
          elementType: LoweredType({
            kind: declaration.elementType.kind,
            name: declaration.elementType.name.copyBytes(
              0,
              declaration.elementType.name.byteLength
            ),
          }),
        }));
      }
      if (!containsLoweredFixedArray(fixedArrays, declaration.name)) {
        fixedArrays.push(move declaration);
      }
    }
    none => {}
  }
  if (name == "OnceState") {
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
  match (genericTypeShape(name)) {
    some(generic) => {
      for (const argument of generic.arguments) {
        try collectIntrinsicTypeName(
          program,
          importedTypes,
          argument,
          inout fixedArrays,
          inout arrays,
          inout slices,
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
          inout fixedArrays,
          inout arrays,
          inout slices,
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
          if (!containsLoweredSlice(slices, declaration.sliceName)) {
            slices.push(LoweredSlice({
              name: declaration.sliceName.copyBytes(
                0,
                declaration.sliceName.byteLength
              ),
              elementType: LoweredType({
                kind: declaration.elementType.kind,
                name: declaration.elementType.name.copyBytes(
                  0,
                  declaration.elementType.name.byteLength
                ),
              }),
            }));
          }
          if (!containsLoweredArray(arrays, declaration.name)) {
            arrays.push(move declaration);
          }
        }
        none => {}
      }
      const slice = try intrinsicSliceDeclaration(
        program,
        importedTypes,
        name
      );
      match (slice) {
        some(declaration) => {
          if (!containsLoweredSlice(slices, declaration.name)) {
            slices.push(move declaration);
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
          const valueOptionName = intrinsicOptionName(declaration.valueType);
          const valueOption = try intrinsicOptionDeclaration(
            program,
            importedTypes,
            valueOptionName
          );
          match (valueOption) {
            some(optionDeclaration) => {
              if (!containsLoweredEnum(enums, optionDeclaration.name)) {
                enums.push(move optionDeclaration);
              }
            }
            none => throw "native Map value Option lowering lost its intrinsic declaration";
          }
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
  inout fixedArrays: Array<LoweredFixedArray>,
  inout arrays: Array<LoweredArray>,
  inout slices: Array<LoweredSlice>,
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
        inout fixedArrays,
        inout arrays,
        inout slices,
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
                inout fixedArrays,
                inout arrays,
                inout slices,
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
                  inout fixedArrays,
                  inout arrays,
                  inout slices,
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
                inout fixedArrays,
                inout arrays,
                inout slices,
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

function collectFunctionIntrinsicTypes(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in declaration: FunctionDeclaration,
  inout fixedArrays: Array<LoweredFixedArray>,
  inout arrays: Array<LoweredArray>,
  inout slices: Array<LoweredSlice>,
  inout maps: Array<LoweredMap>,
  inout sets: Array<LoweredSet>,
  inout enums: Array<LoweredEnum>
): void throws String {
  for (const parameter of declaration.parameters) {
    try collectIntrinsicTypeName(
      program,
      importedTypes,
      parameter.type.name,
      inout fixedArrays,
      inout arrays,
      inout slices,
      inout maps,
      inout sets,
      inout enums
    );
  }
  try collectIntrinsicTypeName(
    program,
    importedTypes,
    declaration.returnType.name,
    inout fixedArrays,
    inout arrays,
    inout slices,
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
        inout fixedArrays,
        inout arrays,
        inout slices,
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
        inout fixedArrays,
        inout arrays,
        inout slices,
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
    inout fixedArrays,
    inout arrays,
    inout slices,
    inout maps,
    inout sets,
    inout enums
  );
}

function programGenericTypeParameterNames(
  in program: Program
): Array<String> {
  let parameters = Array<String>();
  for (const aggregate of program.aggregates) {
    for (const parameter of aggregate.typeParameters) {
      parameters.push(parameter.name.copyBytes(
        0,
        parameter.name.byteLength
      ));
    }
    for (const method of aggregate.methods) {
      for (const parameter of method.typeParameters) {
        parameters.push(parameter.name.copyBytes(
          0,
          parameter.name.byteLength
        ));
      }
    }
  }
  for (const declaration of program.functions) {
    for (const parameter of declaration.typeParameters) {
      parameters.push(parameter.name.copyBytes(
        0,
        parameter.name.byteLength
      ));
    }
  }
  return parameters;
}

function collectIntrinsicEnums(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  includeTests: boolean,
  inout fixedArrays: Array<LoweredFixedArray>,
  inout arrays: Array<LoweredArray>,
  inout slices: Array<LoweredSlice>,
  inout maps: Array<LoweredMap>,
  inout sets: Array<LoweredSet>,
  inout enums: Array<LoweredEnum>
): void throws String {
  const unsettledTypeParameters = programGenericTypeParameterNames(program);
  for (const binding of evidence.bindingResolutions) {
    if (typeContainsGenericParameter(
      binding.typeName,
      unsettledTypeParameters
    )) continue;
    try collectIntrinsicTypeName(
      program,
      importedTypes,
      binding.typeName,
      inout fixedArrays,
      inout arrays,
      inout slices,
      inout maps,
      inout sets,
      inout enums
    );
  }
  for (const expression of evidence.expressionResolutions) {
    if (typeContainsGenericParameter(
      expression.typeName,
      unsettledTypeParameters
    )) continue;
    try collectIntrinsicTypeName(
      program,
      importedTypes,
      expression.typeName,
      inout fixedArrays,
      inout arrays,
      inout slices,
      inout maps,
      inout sets,
      inout enums
    );
  }
  for (const call of evidence.callResolutions) {
    if (call.errorType.byteLength == 0) continue;
    const resultName = `Result<${call.returnType}, ${call.errorType}>`;
    if (typeContainsGenericParameter(
      resultName,
      unsettledTypeParameters
    )) continue;
    try collectIntrinsicTypeName(
      program,
      importedTypes,
      resultName,
      inout fixedArrays,
      inout arrays,
      inout slices,
      inout maps,
      inout sets,
      inout enums
    );
  }
  for (const aggregate of program.aggregates) {
    // Generic aggregate storage and bodies are collected after each concrete
    // demand substitutes its type parameters. Attempting to materialize an
    // intrinsic such as Map<K, T> from the unspecialized declaration leaks T
    // into native lowering and duplicates the concrete collection below.
    if (aggregate.typeParameters.length > 0) continue;
    for (const field of aggregate.fields) {
      try collectIntrinsicTypeName(
        program,
        importedTypes,
        field.type.name,
        inout fixedArrays,
        inout arrays,
        inout slices,
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
        inout fixedArrays,
        inout arrays,
        inout slices,
        inout maps,
        inout sets,
        inout enums
      );
      none => {}
    }
    for (const method of aggregate.methods) {
      try collectFunctionIntrinsicTypes(
        program,
        importedTypes,
        method,
        inout fixedArrays,
        inout arrays,
        inout slices,
        inout maps,
        inout sets,
        inout enums
      );
    }
  }
  for (const declaration of program.enums) {
    for (const variant of declaration.variants) {
      match (in variant.payload) {
        some(type) => try collectIntrinsicTypeName(
          program,
          importedTypes,
          type.name,
          inout fixedArrays,
          inout arrays,
          inout slices,
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
    try collectFunctionIntrinsicTypes(
      program,
      importedTypes,
      declaration,
      inout fixedArrays,
      inout arrays,
      inout slices,
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
        borrowedView: field.borrowedView,
        defaultTarget: field.defaultTarget.copyBytes(
          0,
          field.defaultTarget.byteLength
        ),
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

function loweredStructExecutorBound(
  in structs: Array<LoweredStruct>,
  in name: String
): boolean {
  for (const declaration of structs) {
    if (declaration.name == name) return declaration.executorBound;
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

function appendConcreteGenericStructs(
  in program: Program,
  in uses: Array<LoweredGenericStructUse>,
  moduleIndex: usize,
  inout importedTypes: Array<LoweredImportedType>,
  inout structs: Array<LoweredStruct>
): void throws String {
  for (const use of uses) {
    if (use.consumerModuleIndex != moduleIndex) continue;
    let present = false;
    for (const imported of importedTypes) {
      if (
        imported.localName == use.sourceName
        && imported.targetName == use.emittedName
      ) present = true;
    }
    if (present) continue;
    let fields = Array<LoweredField>();
    let needsDeinit = use.customDeinit || use.referenceType;
    let threadShareable = !use.customDeinit && !use.referenceType;
    let workerDestructible = !use.customDeinit && !use.referenceType;
    let executorBound = use.executorBound;
    if (
      use.consumerModuleIndex != use.ownerModuleIndex
      && containsLoweredStruct(structs, use.emittedName)
    ) {
      fields = loweredStructFields(structs, use.emittedName);
      match (loweredStructCleanup(structs, use.emittedName)) {
        some(value) => needsDeinit = value;
        none => {}
      }
      threadShareable = loweredStructThreadShareable(
        structs,
        use.emittedName
      );
      workerDestructible = loweredStructWorkerDestructible(
        structs,
        use.emittedName
      );
      executorBound = loweredStructExecutorBound(
        structs,
        use.emittedName
      );
    } else {
      for (const sourceField of use.fields) {
        const typeOutcome = attempt lowerModuleTypeName(
          program,
          importedTypes,
          sourceField.typeName
        );
        const type = match (typeOutcome) {
          success(value) => value;
          failure(message) => throw
            `generic aggregate ${use.sourceName} field ${sourceField.name}: ${message}`;
        };
        if (moduleTypeNeedsCleanup(program, importedTypes, type)) {
          needsDeinit = true;
        }
        const visiting = Array<String>();
        if (!moduleTypeIsThreadShareable(
          program,
          importedTypes,
          sourceField.typeName,
          visiting
        )) threadShareable = false;
        if (!moduleTypeIsWorkerDestructible(
          program,
          importedTypes,
          sourceField.typeName,
          visiting
        )) workerDestructible = false;
        if (moduleTypeHasExecutorAffinity(
          program,
          importedTypes,
          sourceField.typeName,
          visiting
        )) executorBound = true;
        fields.push(LoweredField({
          name: sourceField.name.copyBytes(0, sourceField.name.byteLength),
          type,
          optionalField: sourceField.optionalField,
          borrowedView: sourceField.borrowedView,
          defaultTarget: sourceField.hasDefault && !sourceField.optionalField
            ? `Z_${use.emittedName}___default_${sourceField.name}`
            : "",
        }));
      }
    }
    if (!containsLoweredStruct(structs, use.emittedName)) {
      let concreteFields = Array<LoweredField>();
      for (const field of fields) {
        concreteFields.push(LoweredField({
          name: field.name.copyBytes(0, field.name.byteLength),
          type: LoweredType({
            kind: field.type.kind,
            name: field.type.name.copyBytes(0, field.type.name.byteLength),
          }),
          optionalField: field.optionalField,
          borrowedView: field.borrowedView,
          defaultTarget: field.defaultTarget.copyBytes(
            0,
            field.defaultTarget.byteLength
          ),
        }));
      }
      structs.push(LoweredStruct({
        name: use.emittedName.copyBytes(0, use.emittedName.byteLength),
        nativeCName: "",
        fields: move concreteFields,
        referenceType: use.referenceType,
        executorBound,
        threadShareable,
        workerDestructible,
        needsDeinit,
        initializer: Option<LoweredFunction>.none,
        deinitializer: Option<LoweredFunction>.none,
      }));
    }
    importedTypes.push(LoweredImportedType({
      localName: use.sourceName.copyBytes(0, use.sourceName.byteLength),
      targetName: use.emittedName.copyBytes(0, use.emittedName.byteLength),
      nativeTypeName: "",
      kind: use.referenceType
        ? LoweredTypeKind.classType
        : LoweredTypeKind.structType,
      executorBound,
      threadShareable,
      workerDestructible,
      needsDeinit,
      resourceRelease: "",
      fields,
      variants: Array<LoweredVariant>(),
      payloadBearing: false,
      underlyingType: "",
    }));
  }
}

function genericMethodImportedTypes(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in use: LoweredGenericStructUse
): Array<LoweredImportedType> throws String {
  let types = Array<LoweredImportedType>();
  for (const imported of importedTypes) {
    types.push(copyImportedTypeAlias(imported, imported.localName));
  }
  const templateName = concreteGenericTypeName(
    use.ownerName,
    use.typeParameters
  );
  for (const imported of importedTypes) {
    if (
      (
        imported.kind == LoweredTypeKind.structType
        || imported.kind == LoweredTypeKind.classType
      )
      && imported.targetName == use.emittedName
    ) {
      types.push(copyImportedTypeAlias(imported, templateName));
      types.push(copyImportedTypeAlias(imported, use.ownerName));
    }
  }
  let index: usize = 0;
  while (
    index < use.typeParameters.length
    && index < use.typeArguments.length
  ) {
    const concrete = try lowerModuleTypeName(
      program,
      importedTypes,
      use.typeArguments[index]
    );
    let copied = false;
    let importedIndex = importedTypes.length;
    while (importedIndex > 0) {
      importedIndex = importedIndex - 1;
      if (
        importedTypes[importedIndex].kind == concrete.kind
        && importedTypes[importedIndex].targetName == concrete.name
      ) {
        types.push(copyImportedTypeAlias(
          importedTypes[importedIndex],
          use.typeParameters[index]
        ));
        copied = true;
        break;
      }
    }
    if (!copied) {
      types.push(LoweredImportedType({
        localName: use.typeParameters[index].copyBytes(
          0,
          use.typeParameters[index].byteLength
        ),
        targetName: concrete.name.copyBytes(0, concrete.name.byteLength),
        nativeTypeName: "",
        kind: concrete.kind,
        executorBound: false,
        threadShareable: false,
        workerDestructible: !moduleTypeNeedsCleanup(
          program,
          importedTypes,
          concrete
        ),
        needsDeinit: moduleTypeNeedsCleanup(
          program,
          importedTypes,
          concrete
        ),
        resourceRelease: "",
        fields: Array<LoweredField>(),
        variants: Array<LoweredVariant>(),
        payloadBearing: false,
        underlyingType: "",
      }));
    }
    index = index + 1;
  }
  return types;
}

function specializedCallableImportedTypes(
  in program: Program,
  in baseTypes: Array<LoweredImportedType>,
  in typeParameters: Array<String>,
  in typeArguments: Array<String>
): Array<LoweredImportedType> throws String {
  let types = Array<LoweredImportedType>();
  for (const imported of baseTypes) {
    types.push(copyImportedTypeAlias(imported, imported.localName));
  }
  let index: usize = 0;
  while (
    index < typeParameters.length
    && index < typeArguments.length
  ) {
    const concrete = try lowerModuleTypeName(
      program,
      baseTypes,
      typeArguments[index]
    );
    let copied = false;
    let importedIndex = baseTypes.length;
    while (importedIndex > 0) {
      importedIndex = importedIndex - 1;
      if (
        baseTypes[importedIndex].kind == concrete.kind
        && baseTypes[importedIndex].targetName == concrete.name
      ) {
        types.push(copyImportedTypeAlias(
          baseTypes[importedIndex],
          typeParameters[index]
        ));
        copied = true;
        break;
      }
    }
    if (!copied) {
      const needsDeinit = moduleTypeNeedsCleanup(
        program,
        baseTypes,
        concrete
      );
      types.push(LoweredImportedType({
        localName: typeParameters[index].copyBytes(
          0,
          typeParameters[index].byteLength
        ),
        targetName: concrete.name.copyBytes(0, concrete.name.byteLength),
        nativeTypeName: "",
        kind: concrete.kind,
        executorBound: false,
        threadShareable: false,
        workerDestructible: !needsDeinit,
        needsDeinit,
        resourceRelease: "",
        fields: Array<LoweredField>(),
        variants: Array<LoweredVariant>(),
        payloadBearing: false,
        underlyingType: "",
      }));
    }
    index = index + 1;
  }
  return types;
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

function copyImportedTypeAlias(
  in declaration: LoweredImportedType,
  in localName: String
): LoweredImportedType {
  let fields = Array<LoweredField>();
  for (const field of declaration.fields) {
    fields.push(LoweredField({
      name: field.name.copyBytes(0, field.name.byteLength),
      type: LoweredType({
        kind: field.type.kind,
        name: field.type.name.copyBytes(0, field.type.name.byteLength),
      }),
      optionalField: field.optionalField,
      borrowedView: field.borrowedView,
      defaultTarget: field.defaultTarget.copyBytes(
        0,
        field.defaultTarget.byteLength
      ),
      classProperty: field.classProperty,
      objectiveCGetter: field.objectiveCGetter.copyBytes(
        0,
        field.objectiveCGetter.byteLength
      ),
      objectiveCSetter: field.objectiveCSetter.copyBytes(
        0,
        field.objectiveCSetter.byteLength
      ),
    }));
  }
  let variants = Array<LoweredVariant>();
  for (const variant of declaration.variants) {
    variants.push(copyLoweredVariant(variant));
  }
  return LoweredImportedType({
    localName: localName.copyBytes(0, localName.byteLength),
    targetName: declaration.targetName.copyBytes(
      0,
      declaration.targetName.byteLength
    ),
    nativeTypeName: declaration.nativeTypeName.copyBytes(
      0,
      declaration.nativeTypeName.byteLength
    ),
    kind: declaration.kind,
    executorBound: declaration.executorBound,
    threadShareable: declaration.threadShareable,
    workerDestructible: declaration.workerDestructible,
    needsDeinit: declaration.needsDeinit,
    resourceRelease: declaration.resourceRelease.copyBytes(
      0,
      declaration.resourceRelease.byteLength
    ),
    fields,
    variants,
    payloadBearing: declaration.payloadBearing,
    underlyingType: declaration.underlyingType.copyBytes(
      0,
      declaration.underlyingType.byteLength
    ),
  });
}

function loweredForeignFieldType(
  in importedTypes: Array<LoweredImportedType>,
  in name: String
): LoweredType throws String {
  if (name == "view cstring" || name == "view cstring | null") {
    return LoweredType({
      kind: LoweredTypeKind.cstringType,
      name: "cstring",
    });
  }
  if (name == "boolean") return LoweredType({ kind: LoweredTypeKind.booleanType, name: "" });
  if (name == "i8") return LoweredType({ kind: LoweredTypeKind.i8Type, name: "" });
  if (name == "i16") return LoweredType({ kind: LoweredTypeKind.i16Type, name: "" });
  if (name == "i32") return LoweredType({ kind: LoweredTypeKind.i32Type, name: "" });
  if (name == "i64") return LoweredType({ kind: LoweredTypeKind.i64Type, name: "" });
  if (name == "u8") return LoweredType({ kind: LoweredTypeKind.u8Type, name: "" });
  if (name == "u16") return LoweredType({ kind: LoweredTypeKind.u16Type, name: "" });
  if (name == "u32") return LoweredType({ kind: LoweredTypeKind.u32Type, name: "" });
  if (name == "u64") return LoweredType({ kind: LoweredTypeKind.u64Type, name: "" });
  if (name == "isize") return LoweredType({ kind: LoweredTypeKind.isizeType, name: "" });
  if (name == "usize") return LoweredType({ kind: LoweredTypeKind.usizeType, name: "" });
  if (name == "f32") return LoweredType({ kind: LoweredTypeKind.f32Type, name: "" });
  if (name == "f64") return LoweredType({ kind: LoweredTypeKind.f64Type, name: "" });
  const qualifiedMember = qualifiedTypeMember(name);
  for (const imported of importedTypes) {
    if (
      (
        imported.kind == LoweredTypeKind.foreignStructType
        || imported.kind == LoweredTypeKind.foreignEnumType
      )
      && (
        imported.localName == name
        || imported.targetName == name
        || (
          qualifiedMember.byteLength > 0
          && (
            imported.localName == qualifiedMember
            || imported.targetName == qualifiedMember
          )
        )
      )
    ) return LoweredType({
      kind: imported.kind,
      name: imported.targetName.copyBytes(
        0,
        imported.targetName.byteLength
      ),
    });
  }
  throw `native imported record field has unsupported type ${name}`;
}

function appendDeferredGenericAliasType(
  in localName: String,
  in aliasTarget: String,
  moduleIndex: usize,
  in genericStructUses: Array<LoweredGenericStructUse>,
  in structs: Array<LoweredStruct>,
  inout types: Array<LoweredImportedType>
): boolean {
  for (const use of genericStructUses) {
    if (
      use.consumerModuleIndex != moduleIndex
      || use.sourceName != aliasTarget
    ) continue;
    let fields = Array<LoweredField>();
    match (loweredStructCleanup(structs, use.emittedName)) {
      some(_) => fields = loweredStructFields(structs, use.emittedName);
      none => {}
    }
    types.push(LoweredImportedType({
      localName: localName.copyBytes(0, localName.byteLength),
      targetName: use.emittedName.copyBytes(0, use.emittedName.byteLength),
      nativeTypeName: "",
      kind: use.referenceType
        ? LoweredTypeKind.classType
        : LoweredTypeKind.structType,
      executorBound: use.executorBound,
      threadShareable: false,
      workerDestructible: !use.customDeinit && !use.referenceType,
      needsDeinit: use.customDeinit || use.referenceType,
      resourceRelease: "",
      fields,
      variants: Array<LoweredVariant>(),
      payloadBearing: false,
      underlyingType: "",
    }));
    return true;
  }
  return false;
}

function importedTypesForModule(
  in program: Program,
  in graph: ModuleGraph,
  in structs: Array<LoweredStruct>,
  in enums: Array<LoweredEnum>,
  in genericStructUses: Array<LoweredGenericStructUse>,
  moduleIndex: usize
): Array<LoweredImportedType> throws String {
  let types = Array<LoweredImportedType>();
  for (const symbol of graph.modules[moduleIndex].symbols) {
    if (
      symbol.kind != ModuleSymbolKind.classSymbol
      && symbol.kind != ModuleSymbolKind.traitSymbol
      || symbol.foreignHeader.byteLength == 0
    ) continue;
    match (in symbol.typeSignature) {
      some(signature) => {
        const objcInterface = signature.foreignKind == "objcInterface"
          && symbol.kind == ModuleSymbolKind.classSymbol;
        const objcProtocol = signature.foreignKind == "objcProtocol"
          && symbol.kind == ModuleSymbolKind.traitSymbol;
        if (
          (!objcInterface && !objcProtocol)
          || signature.foreignNativeName.byteLength == 0
        ) continue;
        const loweredNativeName = objcProtocol
          ? `id<${signature.foreignNativeName}>`
          : signature.foreignNativeName.copyBytes(
              0,
              signature.foreignNativeName.byteLength
            );
        types.push(LoweredImportedType({
          localName: symbol.name.copyBytes(0, symbol.name.byteLength),
          targetName: loweredNativeName.copyBytes(
            0,
            loweredNativeName.byteLength
          ),
          nativeTypeName: loweredNativeName,
          kind: LoweredTypeKind.foreignObjCType,
          executorBound: signature.executorAffinity.byteLength > 0,
          threadShareable: false,
          workerDestructible: false,
          needsDeinit: false,
          resourceRelease: "",
          fields: Array<LoweredField>(),
          variants: Array<LoweredVariant>(),
          payloadBearing: false,
          underlyingType: "",
        }));
      }
      none => {}
    }
  }
  // A public Z aggregate can carry a foreign Objective-C type through one or
  // more module boundaries. Semantic analysis retains that canonical native
  // identity in member and call evidence, so native lowering must retain the
  // matching ABI type even when the consuming source file did not redundantly
  // import the originating header. This is lowering evidence only: source
  // visibility and member access remain enforced by semantic analysis.
  for (const candidateModule of graph.modules) {
    for (const symbol of candidateModule.symbols) {
      if (
        symbol.kind != ModuleSymbolKind.classSymbol
        && symbol.kind != ModuleSymbolKind.traitSymbol
        || symbol.foreignHeader.byteLength == 0
      ) continue;
      match (in symbol.typeSignature) {
        some(signature) => {
          const objcInterface = signature.foreignKind == "objcInterface"
            && symbol.kind == ModuleSymbolKind.classSymbol;
          const objcProtocol = signature.foreignKind == "objcProtocol"
            && symbol.kind == ModuleSymbolKind.traitSymbol;
          if (
            (!objcInterface && !objcProtocol)
            || signature.foreignNativeName.byteLength == 0
          ) continue;
          const loweredNativeName = objcProtocol
            ? `id<${signature.foreignNativeName}>`
            : signature.foreignNativeName.copyBytes(
                0,
                signature.foreignNativeName.byteLength
              );
          let present = false;
          for (const type of types) {
            if (
              type.kind == LoweredTypeKind.foreignObjCType
              && type.targetName == loweredNativeName
            ) present = true;
          }
          if (present) continue;
          types.push(LoweredImportedType({
            localName: symbol.name.copyBytes(0, symbol.name.byteLength),
            targetName: loweredNativeName.copyBytes(
              0,
              loweredNativeName.byteLength
            ),
            nativeTypeName: loweredNativeName,
            kind: LoweredTypeKind.foreignObjCType,
            executorBound: signature.executorAffinity.byteLength > 0,
            threadShareable: false,
            workerDestructible: false,
            needsDeinit: false,
            resourceRelease: "",
            fields: Array<LoweredField>(),
            variants: Array<LoweredVariant>(),
            payloadBearing: false,
            underlyingType: "",
          }));
        }
        none => {}
      }
    }
  }
  for (const symbol of graph.modules[moduleIndex].symbols) {
    if (
      (
        symbol.kind == ModuleSymbolKind.enumSymbol
        || symbol.kind == ModuleSymbolKind.structSymbol
        || symbol.kind == ModuleSymbolKind.classSymbol
      )
      && symbol.foreignHeader.byteLength > 0
    ) {
      match (in symbol.typeSignature) {
        some(signature) => {
          if (
            symbol.kind == ModuleSymbolKind.classSymbol
            && signature.foreignKind == "objcInterface"
            && signature.foreignNativeName.byteLength > 0
          ) {
            let importedIndex: usize = 0;
            while (
              importedIndex < types.length
              && types[importedIndex].localName != symbol.name
            ) {
              importedIndex = importedIndex + 1;
            }
            if (importedIndex >= types.length) {
              throw `native lowering lost Objective-C type ${symbol.name}`;
            }
            let fields = Array<LoweredField>();
            for (const field of signature.fields) {
              const fieldType = try lowerModuleTypeName(
                program,
                types,
                field.typeName
              );
              fields.push(LoweredField({
                name: field.name.copyBytes(0, field.name.byteLength),
                type: fieldType,
                optionalField: false,
                borrowedView: false,
                defaultTarget: "",
                classProperty: field.classProperty,
                objectiveCGetter: field.objectiveCGetter.copyBytes(
                  0,
                  field.objectiveCGetter.byteLength
                ),
                objectiveCSetter: field.objectiveCSetter.copyBytes(
                  0,
                  field.objectiveCSetter.byteLength
                ),
              }));
            }
            types[importedIndex].fields = move fields;
          } else if (
            symbol.kind == ModuleSymbolKind.enumSymbol
            &&
            signature.foreignNativeName.byteLength > 0
            && signature.foreignUnderlyingType.byteLength > 0
          ) {
            types.push(LoweredImportedType({
              localName: symbol.name.copyBytes(0, symbol.name.byteLength),
              targetName: signature.foreignNativeName.copyBytes(
                0,
                signature.foreignNativeName.byteLength
              ),
              nativeTypeName: signature.foreignNativeName.copyBytes(
                0,
                signature.foreignNativeName.byteLength
              ),
              kind: LoweredTypeKind.foreignEnumType,
              executorBound: false,
              threadShareable: false,
              workerDestructible: false,
              needsDeinit: false,
              resourceRelease: "",
              fields: Array<LoweredField>(),
              variants: Array<LoweredVariant>(),
              payloadBearing: false,
              underlyingType: signature.foreignUnderlyingType.copyBytes(
                0,
                signature.foreignUnderlyingType.byteLength
              ),
            }));
          } else if (
            symbol.kind == ModuleSymbolKind.structSymbol
            && signature.foreignKind == "handle"
            && signature.foreignNativeName.byteLength > 0
          ) {
            types.push(LoweredImportedType({
              localName: symbol.name.copyBytes(0, symbol.name.byteLength),
              targetName: safeForeignHandleName(symbol.name),
              nativeTypeName: signature.foreignNativeName.copyBytes(
                0,
                signature.foreignNativeName.byteLength
              ),
              kind: LoweredTypeKind.foreignHandleType,
              executorBound: false,
              threadShareable: false,
              workerDestructible: false,
              needsDeinit: signature.foreignResourceRelease.byteLength > 0,
              resourceRelease: signature.foreignResourceRelease.copyBytes(
                0,
                signature.foreignResourceRelease.byteLength
              ),
              fields: Array<LoweredField>(),
              variants: Array<LoweredVariant>(),
              payloadBearing: false,
              underlyingType: "",
            }));
          } else if (
            symbol.kind == ModuleSymbolKind.structSymbol
            && signature.foreignNativeName.byteLength > 0
          ) {
            let fields = Array<LoweredField>();
            for (const field of signature.fields) {
              const fieldType = match (attempt loweredForeignFieldType(
                types,
                field.typeName
              )) {
                success(type) => type;
                failure(error) => throw `${error} in field "${symbol.name}.${field.name}"`;
              };
              fields.push(LoweredField({
                name: field.name.copyBytes(0, field.name.byteLength),
                type: fieldType,
                optionalField: false,
                borrowedView: false,
                defaultTarget: "",
              }));
            }
            types.push(LoweredImportedType({
              localName: symbol.name.copyBytes(0, symbol.name.byteLength),
              targetName: signature.foreignNativeName.copyBytes(
                0,
                signature.foreignNativeName.byteLength
              ),
              nativeTypeName: signature.foreignNativeName.copyBytes(
                0,
                signature.foreignNativeName.byteLength
              ),
              kind: LoweredTypeKind.foreignStructType,
              executorBound: false,
              threadShareable: false,
              workerDestructible: signature.foreignResourceRelease.byteLength == 0,
              needsDeinit: signature.foreignResourceRelease.byteLength > 0,
              resourceRelease: signature.foreignResourceRelease.copyBytes(
                0,
                signature.foreignResourceRelease.byteLength
              ),
              fields,
              variants: Array<LoweredVariant>(),
              payloadBearing: false,
              underlyingType: "",
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
            nativeTypeName: "",
            kind: referenceType
              ? LoweredTypeKind.classType
              : LoweredTypeKind.structType,
            executorBound: loweredStructExecutorBound(structs, targetName),
            threadShareable: loweredStructThreadShareable(
              structs,
              targetName
            ),
            workerDestructible: loweredStructWorkerDestructible(
              structs,
              targetName
            ),
            needsDeinit,
            resourceRelease: "",
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
            nativeTypeName: "",
            kind: LoweredTypeKind.enumType,
            executorBound: false,
            threadShareable: false,
            workerDestructible: !declaration.needsDeinit,
            needsDeinit: declaration.needsDeinit,
            resourceRelease: "",
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
  // Visible public or package-internal types can flow through an imported
  // function signature without a second explicit type import in the consuming
  // module. Keep their canonical lowered identity available for inferred locals
  // and intrinsic containers.
  for (const candidateModule of graph.modules) {
    for (const symbol of candidateModule.symbols) {
      if (
        !symbol.exported
        && !(
          symbol.packageVisible
          && candidateModule.packageIdentity.byteLength > 0
          && candidateModule.packageIdentity
            == graph.modules[moduleIndex].packageIdentity
        )
      ) continue;
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
              nativeTypeName: "",
              kind: loweredStructIsReference(structs, symbol.name)
                ? LoweredTypeKind.classType
                : LoweredTypeKind.structType,
              executorBound: loweredStructExecutorBound(
                structs,
                symbol.name
              ),
              threadShareable: loweredStructThreadShareable(
                structs,
                symbol.name
              ),
              workerDestructible: loweredStructWorkerDestructible(
                structs,
                symbol.name
              ),
              needsDeinit,
              resourceRelease: "",
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
              nativeTypeName: "",
              kind: LoweredTypeKind.enumType,
              executorBound: false,
              threadShareable: false,
              workerDestructible: !declaration.needsDeinit,
              needsDeinit: declaration.needsDeinit,
              resourceRelease: "",
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
  // Visible aliases can appear inside fields and return types above without
  // being named directly by the consumer. Resolve them to a fixed point so
  // callable aliases and aliases of aliases remain available to inferred
  // native lowering without redundant source imports.
  let addedPublicAlias = true;
  while (addedPublicAlias) {
    addedPublicAlias = false;
    let candidateModuleIndex: usize = 0;
    for (const candidateModule of graph.modules) {
      const aliasModuleIndex = candidateModuleIndex;
      candidateModuleIndex = candidateModuleIndex + 1;
      for (const symbol of candidateModule.symbols) {
        if (
          !symbol.exported
          && !(
            symbol.packageVisible
            && candidateModule.packageIdentity.byteLength > 0
            && candidateModule.packageIdentity
              == graph.modules[moduleIndex].packageIdentity
          )
        ) continue;
        if (symbol.kind != ModuleSymbolKind.typeAliasSymbol) continue;
        let present = false;
        for (const type of types) {
          if (type.localName == symbol.name) present = true;
        }
        if (present) continue;
        const aliasTarget = rebaseTypeName(
          graph.modules,
          aliasModuleIndex,
          moduleIndex,
          symbol.importedName
        );
        const loweredAttempt = attempt lowerModuleTypeName(
          program,
          types,
          aliasTarget
        );
        match (loweredAttempt) {
          success(lowered) => {
            const visiting = Array<String>();
            types.push(LoweredImportedType({
              localName: symbol.name.copyBytes(
                0,
                symbol.name.byteLength
              ),
              targetName: lowered.name.copyBytes(
                0,
                lowered.name.byteLength
              ),
              nativeTypeName: "",
              kind: lowered.kind,
              executorBound: moduleTypeHasExecutorAffinity(
                program,
                types,
                lowered.name,
                visiting
              ),
              threadShareable: moduleTypeIsThreadShareable(
                program,
                types,
                aliasTarget,
                visiting
              ),
              workerDestructible: moduleTypeIsWorkerDestructible(
                program,
                types,
                lowered.name,
                visiting
              ),
              needsDeinit: moduleTypeNeedsCleanup(
                program,
                types,
                lowered
              ),
              resourceRelease: "",
              fields: Array<LoweredField>(),
              variants: Array<LoweredVariant>(),
              payloadBearing: false,
              underlyingType: lowered.kind == LoweredTypeKind.functionType
                ? aliasTarget.copyBytes(0, aliasTarget.byteLength)
                : "",
            }));
            addedPublicAlias = true;
          }
          failure(_) => {}
        }
      }
    }
  }
  for (const symbol of graph.modules[moduleIndex].symbols) {
    if (symbol.kind != ModuleSymbolKind.importedSymbol) continue;
    let targetModule = graph.modules.length;
    match (in symbol.targetModule) {
      some(index) => targetModule = index;
      none => {}
    }
    if (targetModule >= graph.modules.length) continue;
    const targetSymbolIndex = moduleSymbolIndex(
      graph.modules[targetModule],
      symbol.importedName
    );
    if (
      targetSymbolIndex >= graph.modules[targetModule].symbols.length
      || graph.modules[targetModule].symbols[targetSymbolIndex].kind
        != ModuleSymbolKind.typeAliasSymbol
    ) continue;
    const aliasTarget = rebaseTypeName(
      graph.modules,
      targetModule,
      moduleIndex,
      graph.modules[targetModule].symbols[targetSymbolIndex].importedName
    );
    const loweredOutcome = attempt lowerModuleTypeName(
      program,
      types,
      aliasTarget
    );
    let lowered = LoweredType({
      kind: LoweredTypeKind.voidType,
      name: "",
    });
    match (loweredOutcome) {
      success(type) => lowered = type;
      // A transparent alias can target a concrete generic aggregate whose
      // demand is registered immediately after base imports. Defer that alias
      // rather than turning import discovery order into a source-level cycle.
      failure(_) => {
        if (appendDeferredGenericAliasType(
          symbol.name,
          aliasTarget,
          moduleIndex,
          genericStructUses,
          structs,
          inout types
        )) continue;
        continue;
      }
    }
    if (lowered.kind == LoweredTypeKind.functionType) {
      const visiting = Array<String>();
      types.push(LoweredImportedType({
        localName: symbol.name.copyBytes(0, symbol.name.byteLength),
        targetName: lowered.name.copyBytes(0, lowered.name.byteLength),
        nativeTypeName: "",
        kind: lowered.kind,
        executorBound: false,
        threadShareable: moduleTypeIsThreadShareable(
          program,
          types,
          aliasTarget,
          visiting
        ),
        workerDestructible: moduleTypeIsWorkerDestructible(
          program,
          types,
          lowered.name,
          visiting
        ),
        needsDeinit: moduleTypeNeedsCleanup(program, types, lowered),
        resourceRelease: "",
        fields: Array<LoweredField>(),
        variants: Array<LoweredVariant>(),
        payloadBearing: false,
        // Transparent callable aliases retain their source signature so
        // contextual closure lowering can recover parameter capabilities and
        // throwing effects in the consuming module.
        underlyingType: aliasTarget.copyBytes(0, aliasTarget.byteLength),
      }));
      continue;
    }
    let copiedTarget = Option<LoweredImportedType>.none;
    for (const type of types) {
      if (
        type.kind != lowered.kind
        || type.targetName != lowered.name
      ) continue;
      copiedTarget = Option.some(copyImportedTypeAlias(type, symbol.name));
      break;
    }
    match (copiedTarget) {
      some(type) => {
        types.push(move type);
        continue;
      }
      none => {}
    }
    const visiting = Array<String>();
    types.push(LoweredImportedType({
      localName: symbol.name.copyBytes(0, symbol.name.byteLength),
      targetName: lowered.name.copyBytes(0, lowered.name.byteLength),
      nativeTypeName: "",
      kind: lowered.kind,
      executorBound: moduleTypeHasExecutorAffinity(
        program,
        types,
        lowered.name,
        visiting
      ),
      threadShareable: threadShareablePrimitive(lowered.name),
      workerDestructible: moduleTypeIsWorkerDestructible(
        program,
        types,
        lowered.name,
        visiting
      ),
      needsDeinit: moduleTypeNeedsCleanup(program, types, lowered),
      resourceRelease: "",
      fields: Array<LoweredField>(),
      variants: Array<LoweredVariant>(),
      payloadBearing: false,
      underlyingType: "",
    }));
  }
  return types;
}

function appendGenericDemandArgumentTypes(
  in parsed: Array<ParsedModule>,
  in graph: ModuleGraph,
  in structs: Array<LoweredStruct>,
  in enums: Array<LoweredEnum>,
  in privateTypeCollisionNames: Array<String>,
  in typeArguments: Array<String>,
  in typeArgumentModules: Array<usize>,
  in typeArgumentSymbols: Array<usize>,
  inout types: Array<LoweredImportedType>
): void throws String {
  let argumentIndex: usize = 0;
  while (argumentIndex < typeArguments.length) {
    if (
      argumentIndex >= typeArgumentModules.length
      || argumentIndex >= typeArgumentSymbols.length
      || typeArgumentModules[argumentIndex] >= graph.modules.length
    ) {
      argumentIndex = argumentIndex + 1;
      continue;
    }
    const targetModuleIndex = typeArgumentModules[argumentIndex];
    const targetSymbolIndex = typeArgumentSymbols[argumentIndex];
    if (
      targetSymbolIndex >= graph.modules[targetModuleIndex].symbols.length
      || targetModuleIndex >= parsed.length
    ) throw "native generic-function demand lost a concrete type argument";
    const symbol = view graph.modules[targetModuleIndex].symbols[
      targetSymbolIndex
    ];
    if (
      symbol.kind != ModuleSymbolKind.structSymbol
      && symbol.kind != ModuleSymbolKind.classSymbol
      && symbol.kind != ModuleSymbolKind.enumSymbol
    ) {
      argumentIndex = argumentIndex + 1;
      continue;
    }
    const sourceName = typeArguments[argumentIndex].copyBytes(
      0,
      typeArguments[argumentIndex].byteLength
    );
    const targetName = privateTypeNeedsMangle(
      parsed[targetModuleIndex].program,
      privateTypeCollisionNames,
      symbol.name
    )
      ? emittedPrivateTypeName(targetModuleIndex, symbol.name)
      : symbol.name.copyBytes(0, symbol.name.byteLength);
    let present = false;
    for (const type of types) {
      if (
        type.localName == sourceName
        && type.targetName == targetName
      ) present = true;
    }
    if (present) {
      argumentIndex = argumentIndex + 1;
      continue;
    }
    if (
      symbol.kind == ModuleSymbolKind.structSymbol
      || symbol.kind == ModuleSymbolKind.classSymbol
    ) {
      match (loweredStructCleanup(structs, targetName)) {
        some(needsDeinit) => types.push(LoweredImportedType({
          localName: sourceName,
          targetName: targetName.copyBytes(0, targetName.byteLength),
          nativeTypeName: "",
          kind: loweredStructIsReference(structs, targetName)
            ? LoweredTypeKind.classType
            : LoweredTypeKind.structType,
          executorBound: loweredStructExecutorBound(structs, targetName),
          threadShareable: loweredStructThreadShareable(
            structs,
            targetName
          ),
          workerDestructible: loweredStructWorkerDestructible(
            structs,
            targetName
          ),
          needsDeinit,
          resourceRelease: "",
          fields: loweredStructFields(structs, targetName),
          variants: Array<LoweredVariant>(),
          payloadBearing: false,
          underlyingType: "",
        }));
        none => {
          const visiting = Array<String>();
          const needsDeinit = typeHasCleanup(
            graph.modules,
            targetModuleIndex,
            symbol.name,
            visiting
          );
          let executorBound = false;
          match (in symbol.typeSignature) {
            some(signature) => executorBound = symbol.kind
                == ModuleSymbolKind.classSymbol
              && signature.executorAffinity.byteLength > 0;
            none => {}
          }
          types.push(LoweredImportedType({
            localName: sourceName,
            targetName,
            nativeTypeName: "",
            kind: symbol.kind == ModuleSymbolKind.classSymbol
              ? LoweredTypeKind.classType
              : LoweredTypeKind.structType,
            executorBound,
            threadShareable: typeIsThreadShareable(
              graph.modules,
              targetModuleIndex,
              symbol.name
            ),
            workerDestructible: typeIsThreadTransferable(
              graph.modules,
              targetModuleIndex,
              symbol.name
            ),
            needsDeinit,
            resourceRelease: "",
            fields: Array<LoweredField>(),
            variants: Array<LoweredVariant>(),
            payloadBearing: false,
            underlyingType: "",
          }));
        }
      }
    } else {
      match (loweredEnumCopy(enums, targetName)) {
        some(declaration) => {
          let variants = Array<LoweredVariant>();
          for (const variant of declaration.variants) {
            variants.push(copyLoweredVariant(variant));
          }
          types.push(LoweredImportedType({
            localName: sourceName,
            targetName,
            nativeTypeName: "",
            kind: LoweredTypeKind.enumType,
            executorBound: false,
            threadShareable: false,
            workerDestructible: !declaration.needsDeinit,
            needsDeinit: declaration.needsDeinit,
            resourceRelease: "",
            fields: Array<LoweredField>(),
            variants,
            payloadBearing: declaration.payloadBearing,
            underlyingType: "",
          }));
        }
        none => {
          const visiting = Array<String>();
          const needsDeinit = typeHasCleanup(
            graph.modules,
            targetModuleIndex,
            symbol.name,
            visiting
          );
          types.push(LoweredImportedType({
            localName: sourceName,
            targetName,
            nativeTypeName: "",
            kind: LoweredTypeKind.enumType,
            executorBound: false,
            threadShareable: typeIsThreadShareable(
              graph.modules,
              targetModuleIndex,
              symbol.name
            ),
            workerDestructible: typeIsThreadTransferable(
              graph.modules,
              targetModuleIndex,
              symbol.name
            ),
            needsDeinit,
            resourceRelease: "",
            fields: Array<LoweredField>(),
            variants: Array<LoweredVariant>(),
            payloadBearing: false,
            underlyingType: "",
          }));
        }
      }
    }
    argumentIndex = argumentIndex + 1;
  }
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
  moduleIndex: usize,
  in sourcePath: String,
  inout embeddedBytes: Array<LoweredEmbeddedBytes>
): LoweredConstant throws String {
  match (in declaration.initializer.tree) {
    some(tree) => {
      const root = view tree.nodes[tree.root];
      if (
        root.kind == ExpressionKind.callExpression
        && root.children.length == 2
        && tree.nodes[root.children[0]].kind
          == ExpressionKind.memberExpression
        && tree.nodes[root.children[0]].value == "bytes"
        && tree.nodes[root.children[0]].children.length == 1
      ) {
        const namespace = tree.nodes[root.children[0]].children[0];
        const path = view tree.nodes[root.children[1]];
        if (
          tree.nodes[namespace].kind == ExpressionKind.identifierExpression
          && isImportedStandardNamespace(
            program,
            "std/embed",
            tree.nodes[namespace].value
          )
        ) {
          if (path.kind != ExpressionKind.stringExpression) {
            throw "embed.bytes expects one compile-time string literal path";
          }
          const sourceDirectory = directoryName(sourcePath);
          const requestedPath = `${sourceDirectory}/${path.value}`;
          const requested = normalizedModulePath(requestedPath);
          const canonical = try fs.realPath(requested);
          if (fs.isDirectory(canonical)) {
            throw `could not embed file ${path.value}: path is a directory`;
          }
          const bytes = try fs.readBytes(canonical);
          const storageName = `z_stage1_embedded_bytes_${moduleIndex}_${root.offset}`;
          const embeddedLength = bytes.length;
          embeddedBytes.push(LoweredEmbeddedBytes({
            name: storageName.copyBytes(0, storageName.byteLength),
            sourcePath: canonical.copyBytes(0, canonical.byteLength),
            bytes: move bytes,
          }));
          const type = match (in declaration.typeAnnotation) {
            some(annotation) => try lowerModuleType(
              program,
              importedTypes,
              annotation
            );
            none => LoweredType({
              kind: LoweredTypeKind.staticBytesType,
              name: "StaticBytes",
            });
          };
          return LoweredConstant({
            name: `__z_module_${moduleIndex}_${declaration.name}`,
            type,
            initializerKind: LoweredExpressionKind.emptyValue,
            value: move storageName,
            embeddedLength,
          });
        }
      }
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

function loweredFunctionParameterMode(in mode: String): LoweredParameterMode {
  if (mode == "in") return LoweredParameterMode.input;
  if (mode == "inout") return LoweredParameterMode.inputOutput;
  if (mode == "out") return LoweredParameterMode.output;
  return LoweredParameterMode.value;
}

function containsLoweredFunctionType(
  in functionTypes: Array<LoweredFunctionType>,
  in name: String
): boolean {
  for (const declaration of functionTypes) {
    if (declaration.name == name) return true;
  }
  return false;
}

function collectProgramFunctionTypeName(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in callableAliasTargets: ModuleCallableAliasTargets,
  in typeName: String,
  inout functionTypes: Array<LoweredFunctionType>
): void throws String {
  const target = indexedModuleCallableAliasTarget(
    callableAliasTargets,
    typeName
  );
  match (nativeFunctionSignature(target)) {
    some(signature) => {
      const name = try moduleFunctionTypeIdentity(
        program,
        importedTypes,
        signature
      );
      if (containsLoweredFunctionType(functionTypes, name)) return;
      let parameters = Array<LoweredParameter>();
      let parameter: usize = 0;
      while (parameter < signature.parameterTypes.length) {
        const parameterType = try lowerModuleTypeName(
          program,
          importedTypes,
          signature.parameterTypes[parameter]
        );
        parameters.push(LoweredParameter({
          name: `argument${parameter}`,
          type: parameterType,
          mode: loweredFunctionParameterMode(
            signature.parameterModes[parameter]
          ),
        }));
        parameter = parameter + 1;
      }
      let returnType = try lowerModuleTypeName(
        program,
        importedTypes,
        signature.returnType
      );
      if (signature.errorType.byteLength > 0) {
        const errorType = try lowerModuleTypeName(
          program,
          importedTypes,
          signature.errorType
        );
        returnType = LoweredType({
          kind: LoweredTypeKind.enumType,
          name: intrinsicResultName(returnType, errorType),
        });
      }
      functionTypes.push(LoweredFunctionType({
        name,
        asynchronous: signature.asynchronous,
        parameters,
        returnType,
      }));
    }
    none => {}
  }
}

function collectFunctionDeclarationTypes(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in callableAliasTargets: ModuleCallableAliasTargets,
  in declaration: FunctionDeclaration,
  inout functionTypes: Array<LoweredFunctionType>
): void throws String {
  for (const parameter of declaration.parameters) {
    try collectProgramFunctionTypeName(
      program,
      importedTypes,
      callableAliasTargets,
      parameter.type.name,
      inout functionTypes
    );
  }
  try collectProgramFunctionTypeName(
    program,
    importedTypes,
    callableAliasTargets,
    declaration.returnType.name,
    inout functionTypes
  );
}

function collectProgramAsyncCallFunctionType(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in resolution: ModuleCallResolution,
  inout functionTypes: Array<LoweredFunctionType>
): void throws String {
  if (
    !resolution.asynchronous
    || (
      resolution.kind != "function"
      && resolution.kind != "method"
    )
  ) return;
  const name = try moduleCallFunctionTypeIdentity(
    program,
    importedTypes,
    resolution
  );
  if (containsLoweredFunctionType(functionTypes, name)) return;
  let parameters = Array<LoweredParameter>();
  let parameter: usize = 0;
  while (parameter < resolution.parameterTypes.length) {
    const parameterType = try lowerModuleTypeName(
      program,
      importedTypes,
      resolution.parameterTypes[parameter]
    );
    parameters.push(LoweredParameter({
      name: `argument${parameter}`,
      type: parameterType,
      mode: loweredFunctionParameterMode(
        resolution.parameterModes[parameter]
      ),
    }));
    parameter = parameter + 1;
  }
  let returnType = try lowerModuleTypeName(
    program,
    importedTypes,
    resolution.returnType
  );
  if (resolution.errorType.byteLength > 0) {
    const errorType = try lowerModuleTypeName(
      program,
      importedTypes,
      resolution.errorType
    );
    returnType = LoweredType({
      kind: LoweredTypeKind.enumType,
      name: intrinsicResultName(returnType, errorType),
    });
  }
  functionTypes.push(LoweredFunctionType({
    name,
    asynchronous: true,
    parameters,
    returnType,
  }));
}

function collectProgramFunctionTypes(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  inout functionTypes: Array<LoweredFunctionType>
): void throws String {
  const unsettledTypeParameters = programGenericTypeParameterNames(program);
  let importsTaskScope = false;
  for (const declaration of program.imports) {
    if (declaration.header != "std/async") continue;
    for (const binding of declaration.bindings) {
      if (binding.importedName == "TaskScope") importsTaskScope = true;
    }
  }
  if (importsTaskScope) {
    const taskScopeOperation = encodedFunctionTypeIdentity(
      "async =>void throws "
    );
    if (!containsLoweredFunctionType(
      functionTypes,
      taskScopeOperation
    )) functionTypes.push(LoweredFunctionType({
      name: move taskScopeOperation,
      asynchronous: true,
      parameters: Array<LoweredParameter>(),
      returnType: LoweredType({
        kind: LoweredTypeKind.voidType,
        name: "",
      }),
    }));
  }
  const callableAliasTargets = collectModuleCallableAliasTargets(
    program,
    importedTypes
  );
  for (const alias of program.typeAliases) {
    try collectProgramFunctionTypeName(
      program,
      importedTypes,
      callableAliasTargets,
      alias.name,
      inout functionTypes
    );
  }
  for (const binding of evidence.bindingResolutions) {
    if (typeContainsGenericParameter(
      binding.typeName,
      unsettledTypeParameters
    )) continue;
    try collectProgramFunctionTypeName(
      program,
      importedTypes,
      callableAliasTargets,
      binding.typeName,
      inout functionTypes
    );
  }
  for (const expression of evidence.expressionResolutions) {
    if (typeContainsGenericParameter(
      expression.typeName,
      unsettledTypeParameters
    )) continue;
    try collectProgramFunctionTypeName(
      program,
      importedTypes,
      callableAliasTargets,
      expression.typeName,
      inout functionTypes
    );
  }
  for (const call of evidence.callResolutions) {
    let unsettled = typeContainsGenericParameter(
      call.returnType,
      unsettledTypeParameters
    ) || (
      call.errorType.byteLength > 0
      && typeContainsGenericParameter(
        call.errorType,
        unsettledTypeParameters
      )
    );
    for (const parameterType of call.parameterTypes) {
      if (typeContainsGenericParameter(
        parameterType,
        unsettledTypeParameters
      )) unsettled = true;
    }
    if (unsettled) continue;
    try collectProgramAsyncCallFunctionType(
      program,
      importedTypes,
      call,
      inout functionTypes
    );
    for (const parameterType of call.parameterTypes) {
      try collectProgramFunctionTypeName(
        program,
        importedTypes,
        callableAliasTargets,
        parameterType,
        inout functionTypes
      );
    }
  }
  for (const declaration of program.functions) {
    if (declaration.typeParameters.length > 0) continue;
    try collectFunctionDeclarationTypes(
      program,
      importedTypes,
      callableAliasTargets,
      declaration,
      inout functionTypes
    );
  }
  for (const aggregate of program.aggregates) {
    if (aggregate.typeParameters.length > 0) continue;
    for (const field of aggregate.fields) {
      try collectProgramFunctionTypeName(
        program,
        importedTypes,
        callableAliasTargets,
        field.type.name,
        inout functionTypes
      );
    }
    for (const method of aggregate.methods) {
      if (method.typeParameters.length > 0) continue;
      try collectFunctionDeclarationTypes(
        program,
        importedTypes,
        callableAliasTargets,
        method,
        inout functionTypes
      );
    }
  }
}

function appendLoweredProgram(
  in program: Program,
  in sourcePath: String,
  inout importedTypes: Array<LoweredImportedType>,
  in genericStructUses: Array<LoweredGenericStructUse>,
  in genericMethodUses: Array<LoweredGenericMethodUse>,
  in genericFunctionUses: Array<LoweredGenericFunctionUse>,
  in evidence: ModuleSemanticEvidence,
  in privateFunctionCollisionNames: Array<String>,
  in privateTypeCollisionNames: Array<String>,
  moduleIndex: usize,
  entryIndex: usize,
  includeTests: boolean,
  inout embeddedBytes: Array<LoweredEmbeddedBytes>,
  inout constants: Array<LoweredConstant>,
  inout fixedArrays: Array<LoweredFixedArray>,
  inout arrays: Array<LoweredArray>,
  inout slices: Array<LoweredSlice>,
  inout maps: Array<LoweredMap>,
  inout sets: Array<LoweredSet>,
  inout functionTypes: Array<LoweredFunctionType>,
  inout structs: Array<LoweredStruct>,
  inout enums: Array<LoweredEnum>,
  inout functions: Array<LoweredFunction>
): void throws String {
  for (const declaration of program.constants) {
    const loweredConstant = try lowerModuleConstant(
      program,
      importedTypes,
      declaration,
      moduleIndex,
      sourcePath,
      inout embeddedBytes
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
      nativeTypeName: "",
      kind: LoweredTypeKind.enumType,
      executorBound: false,
      threadShareable: false,
      workerDestructible: false,
      needsDeinit: false,
      resourceRelease: "",
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
    let executorBound = false;
    if (aggregate.kind == DeclarationKind.classDeclaration) {
      const visiting = Array<String>();
      executorBound = moduleTypeHasExecutorAffinity(
        program,
        importedTypes,
        aggregate.name,
        visiting
      );
    }
    importedTypes.push(LoweredImportedType({
      localName: aggregate.name.copyBytes(0, aggregate.name.byteLength),
      targetName,
      nativeTypeName: "",
      kind: aggregate.kind == DeclarationKind.classDeclaration
        ? LoweredTypeKind.classType
        : LoweredTypeKind.structType,
      executorBound,
      threadShareable: false,
      workerDestructible: false,
      needsDeinit: false,
      resourceRelease: "",
      fields: Array<LoweredField>(),
      variants: Array<LoweredVariant>(),
      payloadBearing: false,
      underlyingType: "",
    }));
  }

  // Register concrete generic aggregate identities before lowering function
  // signatures and intrinsic wrappers such as Weak<Cell<i32>>. The concrete
  // fields only require lowered type identities; their intrinsic runtime
  // declarations are still collected below.
  try appendConcreteGenericStructs(
    program,
    genericStructUses,
    moduleIndex,
    inout importedTypes,
    inout structs
  );

  try collectProgramFunctionTypes(
    program,
    importedTypes,
    evidence,
    inout functionTypes
  );

  try collectIntrinsicEnums(
    program,
    importedTypes,
    evidence,
    includeTests,
    inout fixedArrays,
    inout arrays,
    inout slices,
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
      nativeTypeName: "",
      kind: LoweredTypeKind.enumType,
      executorBound: false,
      threadShareable: false,
      workerDestructible: !needsDeinit,
      needsDeinit,
      resourceRelease: "",
      fields: Array<LoweredField>(),
      variants: importedVariants,
      payloadBearing,
      underlyingType: "",
    }));
  }

  for (const aggregate of program.aggregates) {
    if (aggregate.typeParameters.length > 0) continue;
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
    ) {
      throw "native lowering only supports structs and classes yet";
    }
    let fields = Array<LoweredField>();
    for (const field of aggregate.fields) {
      const fieldType = try lowerModuleType(
        program,
        importedTypes,
        field.type
      );
      let defaultTarget = "";
      match (in field.defaultValue) {
        some(_) => defaultTarget = `Z_${emittedName}___default_${field.name}`;
        none => {}
      }
      fields.push(LoweredField({
        name: field.name.copyBytes(0, field.name.byteLength),
        type: move fieldType,
        optionalField: field.optionalField,
        borrowedView: stringStartsWith(field.type.name, "view "),
        defaultTarget,
      }));
    }
    let initializer = Option<LoweredFunction>.none;
    if (aggregate.kind == DeclarationKind.classDeclaration) {
      match (in aggregate.constructorDeclaration) {
        some(source) => {
          const loweredInitializer = try lowerConstructor(
            program,
            importedTypes,
            evidence,
            sourcePath,
            aggregate.name,
            emittedName,
            source
          );
          initializer = Option.some(move loweredInitializer);
        }
        none => {}
      }
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
    const executorBound = aggregate.kind == DeclarationKind.classDeclaration
      && moduleTypeHasExecutorAffinity(
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
      executorBound,
      threadShareable,
      workerDestructible,
      needsDeinit,
      initializer,
      deinitializer,
    }));
  }

  for (const aggregate of program.aggregates) {
    if (aggregate.typeParameters.length > 0) continue;
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
          nativeTypeName: "",
          kind: aggregate.kind == DeclarationKind.classDeclaration
            ? LoweredTypeKind.classType
            : LoweredTypeKind.structType,
          executorBound: loweredStructExecutorBound(
            structs,
            emittedName
          ),
          threadShareable: loweredStructThreadShareable(
            structs,
            emittedName
          ),
          workerDestructible: loweredStructWorkerDestructible(
            structs,
            emittedName
          ),
          needsDeinit,
          resourceRelease: "",
          fields,
          variants: Array<LoweredVariant>(),
          payloadBearing: false,
          underlyingType: "",
        }));
      }
      none => {}
    }
  }

  for (const use of genericStructUses) {
    if (use.consumerModuleIndex != moduleIndex) continue;
    for (const field of use.fields) {
      try collectIntrinsicTypeName(
        program,
        importedTypes,
        field.typeName,
        inout fixedArrays,
        inout arrays,
        inout slices,
        inout maps,
        inout sets,
        inout enums
      );
    }
  }

  for (const use of genericStructUses) {
    if (
      use.consumerModuleIndex != moduleIndex
      || use.ownerModuleIndex != moduleIndex
    ) continue;
    let aggregateIndex = program.aggregates.length;
    let candidateIndex: usize = 0;
    while (candidateIndex < program.aggregates.length) {
      if (
        program.aggregates[candidateIndex].name == use.ownerName
        && program.aggregates[candidateIndex].typeParameters.length > 0
      ) {
        aggregateIndex = candidateIndex;
        break;
      }
      candidateIndex = candidateIndex + 1;
    }
    if (aggregateIndex >= program.aggregates.length) {
      throw `native generic method lowering lost owner ${use.ownerName}`;
    }
    const aggregate = view program.aggregates[aggregateIndex];
    let hasDefaults = false;
    for (const field of aggregate.fields) {
      match (in field.defaultValue) {
        some(_) => hasDefaults = true;
        none => {}
      }
    }
    let hasDeinitializer = false;
    match (in aggregate.deinitializer) {
      some(_) => hasDeinitializer = true;
      none => {}
    }
    let hasInitializer = false;
    match (in aggregate.constructorDeclaration) {
      some(_) => hasInitializer = true;
      none => {}
    }
    if (
      aggregate.methods.length == 0
      && !hasDefaults
      && !hasDeinitializer
      && !hasInitializer
    ) continue;
    const methodImportedTypes = try genericMethodImportedTypes(
      program,
      importedTypes,
      use
    );
    const callableAliasTargets = collectModuleCallableAliasTargets(
      program,
      methodImportedTypes
    );
    match (in aggregate.constructorDeclaration) {
      some(source) => for (const parameter of source.parameters) {
        try collectProgramFunctionTypeName(
          program,
          methodImportedTypes,
          callableAliasTargets,
          parameter.type.name,
          inout functionTypes
        );
      }
      none => {}
    }
    for (const method of aggregate.methods) {
      if (method.typeParameters.length > 0) continue;
      try collectFunctionDeclarationTypes(
        program,
        methodImportedTypes,
        callableAliasTargets,
        method,
        inout functionTypes
      );
    }
    match (in aggregate.constructorDeclaration) {
      some(source) => {
        for (const parameter of source.parameters) {
          try collectIntrinsicTypeName(
            program,
            methodImportedTypes,
            parameter.type.name,
            inout fixedArrays,
            inout arrays,
            inout slices,
            inout maps,
            inout sets,
            inout enums
          );
        }
        try collectArenaIntrinsicEnums(
          program,
          methodImportedTypes,
          source.body,
          inout fixedArrays,
          inout arrays,
          inout slices,
          inout maps,
          inout sets,
          inout enums
        );
        let loweredInitializer = try lowerConstructor(
          program,
          methodImportedTypes,
          evidence,
          sourcePath,
          aggregate.name,
          use.emittedName,
          source
        );
        rewritePrivateCallTargets(
          program,
          privateFunctionCollisionNames,
          moduleIndex,
          entryIndex,
          inout loweredInitializer
        );
        let structIndex: usize = 0;
        let installed = false;
        while (structIndex < structs.length) {
          if (structs[structIndex].name == use.emittedName) {
            structs[structIndex].initializer = Option.some(
              move loweredInitializer
            );
            installed = true;
            break;
          }
          structIndex = structIndex + 1;
        }
        if (!installed) {
          throw `native generic constructor lowering lost ${use.sourceName}`;
        }
      }
      none => {}
    }
    match (in aggregate.deinitializer) {
      some(source) => {
        try collectArenaIntrinsicEnums(
          program,
          methodImportedTypes,
          source.body,
          inout fixedArrays,
          inout arrays,
          inout slices,
          inout maps,
          inout sets,
          inout enums
        );
        let loweredDeinitializer = try lowerDeinitializer(
          program,
          methodImportedTypes,
          evidence,
          aggregate.name,
          source.body
        );
        loweredDeinitializer.name = `${use.emittedName}.deinit`;
        rewritePrivateCallTargets(
          program,
          privateFunctionCollisionNames,
          moduleIndex,
          entryIndex,
          inout loweredDeinitializer
        );
        let structIndex: usize = 0;
        let installed = false;
        while (structIndex < structs.length) {
          if (structs[structIndex].name == use.emittedName) {
            structs[structIndex].needsDeinit = true;
            structs[structIndex].deinitializer = Option.some(
              move loweredDeinitializer
            );
            installed = true;
            break;
          }
          structIndex = structIndex + 1;
        }
        if (!installed) {
          throw `native generic deinit lowering lost ${use.sourceName}`;
        }
      }
      none => {}
    }
    for (const field of aggregate.fields) {
      match (in field.defaultValue) {
        some(_) => {
          const target = `Z_${use.emittedName}___default_${field.name}`;
          let loweredDefault = try lowerGenericFieldDefault(
            program,
            methodImportedTypes,
            evidence,
            sourcePath,
            target,
            field
          );
          rewritePrivateCallTargets(
            program,
            privateFunctionCollisionNames,
            moduleIndex,
            entryIndex,
            inout loweredDefault
          );
          functions.push(move loweredDefault);
        }
        none => {}
      }
    }
    for (const method of aggregate.methods) {
      if (method.typeParameters.length > 0) continue;
      try collectFunctionIntrinsicTypes(
        program,
        methodImportedTypes,
        method,
        inout fixedArrays,
        inout arrays,
        inout slices,
        inout maps,
        inout sets,
        inout enums
      );
      const ownerName = semanticMethodOwnerName(
        aggregate.name,
        method.name
      );
      const methodReceiverMode = method.staticMethod
        ? ReceiverMode.none
        : method.receiverMode;
      const methodReceiverName = method.staticMethod
        ? ""
        : use.emittedName.copyBytes(0, use.emittedName.byteLength);
      const methodReceiverKind = method.staticMethod
        ? LoweredTypeKind.voidType
        : aggregate.kind == DeclarationKind.classDeclaration
          ? LoweredTypeKind.classType
          : LoweredTypeKind.structType;
      const loweredMethodOutcome = attempt lowerFunction(
        program,
        methodImportedTypes,
        evidence,
        method,
        ownerName,
        sourcePath,
        methodReceiverName,
        methodReceiverKind,
        methodReceiverMode
      );
      let loweredMethod = match (loweredMethodOutcome) {
        success(lowered) => lowered;
        failure(message) => throw
          `method ${use.sourceName}.${method.name}: ${message}`;
      };
      loweredMethod.name = `Z_${use.emittedName}_${method.name}`;
      loweredMethod.nativeCExportName = "";
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

  // A default belongs to the module that declared the struct. Emit one
  // private helper there so construction through an imported type evaluates
  // the same checked expression instead of silently zero-initializing the
  // omitted field in the consuming module.
  for (const aggregate of program.aggregates) {
    if (aggregate.typeParameters.length > 0) continue;
    const emittedName = privateTypeNeedsMangle(
      program,
      privateTypeCollisionNames,
      aggregate.name
    )
      ? emittedPrivateTypeName(moduleIndex, aggregate.name)
      : aggregate.name.copyBytes(0, aggregate.name.byteLength);
    for (const field of aggregate.fields) {
      match (in field.defaultValue) {
        some(_) => {
          const target = `Z_${emittedName}___default_${field.name}`;
          let loweredDefault = try lowerGenericFieldDefault(
            program,
            importedTypes,
            evidence,
            sourcePath,
            target,
            field
          );
          rewritePrivateCallTargets(
            program,
            privateFunctionCollisionNames,
            moduleIndex,
            entryIndex,
            inout loweredDefault
          );
          functions.push(move loweredDefault);
        }
        none => {}
      }
    }
  }

  for (const aggregate of program.aggregates) {
    if (aggregate.typeParameters.length > 0) continue;
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
      const ownerName = semanticMethodOwnerName(
        aggregate.name,
        method.name
      );
      if (method.typeParameters.length > 0) continue;
      const methodReceiverMode = method.staticMethod
        ? ReceiverMode.none
        : method.receiverMode;
      const methodReceiverName = method.staticMethod
        ? ""
        : emittedName.copyBytes(0, emittedName.byteLength);
      const methodReceiverKind = method.staticMethod
        ? LoweredTypeKind.voidType
        : receiverKind;
      const loweredMethodOutcome = attempt lowerFunction(
        program,
        importedTypes,
        evidence,
        method,
        ownerName,
        sourcePath,
        methodReceiverName,
        methodReceiverKind,
        methodReceiverMode
      );
      let loweredMethod = match (loweredMethodOutcome) {
        success(lowered) => lowered;
        failure(message) => throw `method ${aggregate.name}.${method.name}: ${message}`;
      };
      loweredMethod.name = `Z_${emittedName}_${method.name}`;
      loweredMethod.nativeCExportName = "";
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

  for (const use of genericMethodUses) {
    if (use.ownerModuleIndex != moduleIndex) continue;
    let aggregateIndex = program.aggregates.length;
    let candidateIndex: usize = 0;
    while (candidateIndex < program.aggregates.length) {
      if (program.aggregates[candidateIndex].name == use.ownerName) {
        aggregateIndex = candidateIndex;
        break;
      }
      candidateIndex = candidateIndex + 1;
    }
    if (aggregateIndex >= program.aggregates.length) {
      throw `native generic-method lowering lost owner ${use.ownerName}`;
    }
    const aggregate = view program.aggregates[aggregateIndex];
    let ownerEmittedName = privateTypeNeedsMangle(
      program,
      privateTypeCollisionNames,
      aggregate.name
    )
      ? emittedPrivateTypeName(moduleIndex, aggregate.name)
      : aggregate.name.copyBytes(0, aggregate.name.byteLength);
    let ownerImportedTypes = Array<LoweredImportedType>();
    if (aggregate.typeParameters.length > 0) {
      let ownerUseIndex: usize = genericStructUses.length;
      let genericIndex: usize = 0;
      while (genericIndex < genericStructUses.length) {
        if (
          genericStructUses[genericIndex].consumerModuleIndex == moduleIndex
          && genericStructUses[genericIndex].ownerModuleIndex == moduleIndex
          && genericStructUses[genericIndex].ownerName == use.ownerName
          && sameStrings(
            genericStructUses[genericIndex].typeArguments,
            use.ownerTypeArguments
          )
        ) {
          ownerUseIndex = genericIndex;
          break;
        }
        genericIndex = genericIndex + 1;
      }
      if (ownerUseIndex >= genericStructUses.length) {
        throw `native generic-method lowering lost concrete owner ${use.ownerName}`;
      }
      ownerEmittedName = genericStructUses[ownerUseIndex].emittedName
        .copyBytes(
          0,
          genericStructUses[ownerUseIndex].emittedName.byteLength
        );
      ownerImportedTypes = try genericMethodImportedTypes(
        program,
        importedTypes,
        genericStructUses[ownerUseIndex]
      );
    } else {
      const noTypeParameters = Array<String>();
      const noTypeArguments = Array<String>();
      ownerImportedTypes = try specializedCallableImportedTypes(
        program,
        importedTypes,
        noTypeParameters,
        noTypeArguments
      );
    }
    const methodImportedTypes = try specializedCallableImportedTypes(
      program,
      ownerImportedTypes,
      use.methodTypeParameters,
      use.methodTypeArguments
    );
    const suffix = try genericCallableSpecializationSuffix(
      program,
      methodImportedTypes,
      use.allTypeArguments
    );
    let emitted = false;
    for (const method of aggregate.methods) {
      if (
        method.name != use.methodName
        || method.typeParameters.length == 0
      ) continue;
      try collectFunctionIntrinsicTypes(
        program,
        methodImportedTypes,
        method,
        inout fixedArrays,
        inout arrays,
        inout slices,
        inout maps,
        inout sets,
        inout enums
      );
      const ownerName = semanticMethodOwnerName(
        aggregate.name,
        method.name
      );
      const methodReceiverMode = method.staticMethod
        ? ReceiverMode.none
        : method.receiverMode;
      const methodReceiverName = method.staticMethod
        ? ""
        : ownerEmittedName.copyBytes(0, ownerEmittedName.byteLength);
      const methodReceiverKind = method.staticMethod
        ? LoweredTypeKind.voidType
        : aggregate.kind == DeclarationKind.classDeclaration
          ? LoweredTypeKind.classType
          : LoweredTypeKind.structType;
      const loweredMethodOutcome = attempt lowerFunction(
        program,
        methodImportedTypes,
        evidence,
        method,
        ownerName,
        sourcePath,
        methodReceiverName,
        methodReceiverKind,
        methodReceiverMode
      );
      let loweredMethod = match (loweredMethodOutcome) {
        success(lowered) => lowered;
        failure(message) => throw
          `method ${aggregate.name}.${method.name}: ${message}`;
      };
      loweredMethod.name = `Z_${ownerEmittedName}_${method.name}${suffix}`;
      loweredMethod.nativeCExportName = "";
      rewritePrivateCallTargets(
        program,
        privateFunctionCollisionNames,
        moduleIndex,
        entryIndex,
        inout loweredMethod
      );
      functions.push(move loweredMethod);
      emitted = true;
      break;
    }
    if (!emitted) {
      throw `native generic-method lowering lost ${use.ownerName}.${use.methodName}`;
    }
  }

  for (const declaration of program.functions) {
    if (declaration.testDeclaration && !includeTests) continue;
    if (declaration.typeParameters.length > 0) continue;
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
      declaration.name,
      sourcePath,
      "",
      LoweredTypeKind.voidType,
      ReceiverMode.none
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

  for (const use of genericFunctionUses) {
    if (use.ownerModuleIndex != moduleIndex) continue;
    let declarationIndex = program.functions.length;
    let candidateIndex: usize = 0;
    while (candidateIndex < program.functions.length) {
      if (
        program.functions[candidateIndex].name == use.name
        && program.functions[candidateIndex].typeParameters.length > 0
      ) {
        declarationIndex = candidateIndex;
        break;
      }
      candidateIndex = candidateIndex + 1;
    }
    if (declarationIndex >= program.functions.length) {
      throw `native generic-function lowering lost ${use.name}`;
    }
    const declaration = view program.functions[declarationIndex];
    const specializedTypes = try specializedCallableImportedTypes(
      program,
      importedTypes,
      use.typeParameters,
      use.typeArguments
    );
    try collectFunctionIntrinsicTypes(
      program,
      specializedTypes,
      declaration,
      inout fixedArrays,
      inout arrays,
      inout slices,
      inout maps,
      inout sets,
      inout enums
    );
    const suffix = try genericCallableSpecializationSuffix(
      program,
      specializedTypes,
      use.typeArguments
    );
    const loweredFunctionOutcome = attempt lowerFunction(
      program,
      specializedTypes,
      evidence,
      declaration,
      declaration.name,
      sourcePath,
      "",
      LoweredTypeKind.voidType,
      ReceiverMode.none
    );
    let loweredFunction = match (loweredFunctionOutcome) {
      success(lowered) => lowered;
      failure(message) => throw `function ${declaration.name}: ${message}`;
    };
    try attachGenericCompilerIntrinsic(
      program,
      specializedTypes,
      sourcePath,
      use,
      inout loweredFunction
    );
    rewritePrivateCallTargets(
      program,
      privateFunctionCollisionNames,
      moduleIndex,
      entryIndex,
      inout loweredFunction
    );
    const baseName = privateFunctionNeedsMangle(
      program,
      privateFunctionCollisionNames,
      moduleIndex,
      entryIndex,
      declaration.name
    )
      ? emittedPrivateFunctionName(moduleIndex, declaration.name)
      : declaration.name.copyBytes(0, declaration.name.byteLength);
    loweredFunction.name = `${baseName}${suffix}`;
    loweredFunction.nativeCExportName = "";
    functions.push(move loweredFunction);
  }
}

function appendDeferredGenericMethod(
  in program: Program,
  in sourcePath: String,
  in importedTypes: Array<LoweredImportedType>,
  in genericStructUses: Array<LoweredGenericStructUse>,
  in use: LoweredGenericMethodUse,
  in evidence: ModuleSemanticEvidence,
  in privateFunctionCollisionNames: Array<String>,
  in privateTypeCollisionNames: Array<String>,
  moduleIndex: usize,
  entryIndex: usize,
  inout fixedArrays: Array<LoweredFixedArray>,
  inout arrays: Array<LoweredArray>,
  inout slices: Array<LoweredSlice>,
  inout maps: Array<LoweredMap>,
  inout sets: Array<LoweredSet>,
  inout enums: Array<LoweredEnum>,
  inout functions: Array<LoweredFunction>
): void throws String {
  let aggregateIndex = program.aggregates.length;
  let candidateIndex: usize = 0;
  while (candidateIndex < program.aggregates.length) {
    if (program.aggregates[candidateIndex].name == use.ownerName) {
      aggregateIndex = candidateIndex;
      break;
    }
    candidateIndex = candidateIndex + 1;
  }
  if (aggregateIndex >= program.aggregates.length) {
    throw `native generic-method lowering lost owner ${use.ownerName}`;
  }
  const aggregate = view program.aggregates[aggregateIndex];
  let ownerEmittedName = privateTypeNeedsMangle(
    program,
    privateTypeCollisionNames,
    aggregate.name
  )
    ? emittedPrivateTypeName(moduleIndex, aggregate.name)
    : aggregate.name.copyBytes(0, aggregate.name.byteLength);
  let ownerImportedTypes = Array<LoweredImportedType>();
  if (aggregate.typeParameters.length > 0) {
    let ownerUseIndex: usize = genericStructUses.length;
    let genericIndex: usize = 0;
    while (genericIndex < genericStructUses.length) {
      if (
        genericStructUses[genericIndex].consumerModuleIndex == moduleIndex
        && genericStructUses[genericIndex].ownerModuleIndex == moduleIndex
        && genericStructUses[genericIndex].ownerName == use.ownerName
        && sameStrings(
          genericStructUses[genericIndex].typeArguments,
          use.ownerTypeArguments
        )
      ) {
        ownerUseIndex = genericIndex;
        break;
      }
      genericIndex = genericIndex + 1;
    }
    if (ownerUseIndex >= genericStructUses.length) {
      throw `native generic-method lowering lost concrete owner ${use.ownerName}`;
    }
    ownerEmittedName = genericStructUses[ownerUseIndex].emittedName
      .copyBytes(
        0,
        genericStructUses[ownerUseIndex].emittedName.byteLength
      );
    ownerImportedTypes = try genericMethodImportedTypes(
      program,
      importedTypes,
      genericStructUses[ownerUseIndex]
    );
  } else {
    const noTypeParameters = Array<String>();
    const noTypeArguments = Array<String>();
    ownerImportedTypes = try specializedCallableImportedTypes(
      program,
      importedTypes,
      noTypeParameters,
      noTypeArguments
    );
  }
  const methodImportedTypes = try specializedCallableImportedTypes(
    program,
    ownerImportedTypes,
    use.methodTypeParameters,
    use.methodTypeArguments
  );
  const suffix = try genericCallableSpecializationSuffix(
    program,
    methodImportedTypes,
    use.allTypeArguments
  );
  for (const method of aggregate.methods) {
    if (
      method.name != use.methodName
      || method.typeParameters.length == 0
    ) continue;
    try collectFunctionIntrinsicTypes(
      program,
      methodImportedTypes,
      method,
      inout fixedArrays,
      inout arrays,
      inout slices,
      inout maps,
      inout sets,
      inout enums
    );
    const ownerName = semanticMethodOwnerName(
      aggregate.name,
      method.name
    );
    const methodReceiverMode = method.staticMethod
      ? ReceiverMode.none
      : method.receiverMode;
    const methodReceiverName = method.staticMethod
      ? ""
      : ownerEmittedName.copyBytes(0, ownerEmittedName.byteLength);
    const methodReceiverKind = method.staticMethod
      ? LoweredTypeKind.voidType
      : aggregate.kind == DeclarationKind.classDeclaration
        ? LoweredTypeKind.classType
        : LoweredTypeKind.structType;
    const loweredMethodOutcome = attempt lowerFunction(
      program,
      methodImportedTypes,
      evidence,
      method,
      ownerName,
      sourcePath,
      methodReceiverName,
      methodReceiverKind,
      methodReceiverMode
    );
    let loweredMethod = match (loweredMethodOutcome) {
      success(lowered) => lowered;
      failure(message) => throw
        `method ${aggregate.name}.${method.name}: ${message}`;
    };
    loweredMethod.name = `Z_${ownerEmittedName}_${method.name}${suffix}`;
    loweredMethod.nativeCExportName = "";
    rewritePrivateCallTargets(
      program,
      privateFunctionCollisionNames,
      moduleIndex,
      entryIndex,
      inout loweredMethod
    );
    functions.push(move loweredMethod);
    return;
  }
  throw `native generic-method lowering lost ${use.ownerName}.${use.methodName}`;
}

function appendDeferredGenericFunction(
  in program: Program,
  in sourcePath: String,
  in importedTypes: Array<LoweredImportedType>,
  in use: LoweredGenericFunctionUse,
  in evidence: ModuleSemanticEvidence,
  in privateFunctionCollisionNames: Array<String>,
  moduleIndex: usize,
  entryIndex: usize,
  inout fixedArrays: Array<LoweredFixedArray>,
  inout arrays: Array<LoweredArray>,
  inout slices: Array<LoweredSlice>,
  inout maps: Array<LoweredMap>,
  inout sets: Array<LoweredSet>,
  inout enums: Array<LoweredEnum>,
  inout functions: Array<LoweredFunction>
): void throws String {
  let declarationIndex = program.functions.length;
  let candidateIndex: usize = 0;
  while (candidateIndex < program.functions.length) {
    if (
      program.functions[candidateIndex].name == use.name
      && program.functions[candidateIndex].typeParameters.length > 0
    ) {
      declarationIndex = candidateIndex;
      break;
    }
    candidateIndex = candidateIndex + 1;
  }
  if (declarationIndex >= program.functions.length) {
    throw `native generic-function lowering lost ${use.name}`;
  }
  const declaration = view program.functions[declarationIndex];
  const specializedTypes = try specializedCallableImportedTypes(
    program,
    importedTypes,
    use.typeParameters,
    use.typeArguments
  );
  try collectFunctionIntrinsicTypes(
    program,
    specializedTypes,
    declaration,
    inout fixedArrays,
    inout arrays,
    inout slices,
    inout maps,
    inout sets,
    inout enums
  );
  const suffix = try genericCallableSpecializationSuffix(
    program,
    specializedTypes,
    use.typeArguments
  );
  const loweredFunctionOutcome = attempt lowerFunction(
    program,
    specializedTypes,
    evidence,
    declaration,
    declaration.name,
    sourcePath,
    "",
    LoweredTypeKind.voidType,
    ReceiverMode.none
  );
  let loweredFunction = match (loweredFunctionOutcome) {
    success(lowered) => lowered;
    failure(message) => throw `function ${declaration.name}: ${message}`;
  };
  try attachGenericCompilerIntrinsic(
    program,
    specializedTypes,
    sourcePath,
    use,
    inout loweredFunction
  );
  rewritePrivateCallTargets(
    program,
    privateFunctionCollisionNames,
    moduleIndex,
    entryIndex,
    inout loweredFunction
  );
  const baseName = privateFunctionNeedsMangle(
    program,
    privateFunctionCollisionNames,
    moduleIndex,
    entryIndex,
    declaration.name
  )
    ? emittedPrivateFunctionName(moduleIndex, declaration.name)
    : declaration.name.copyBytes(0, declaration.name.byteLength);
  loweredFunction.name = `${baseName}${suffix}`;
  loweredFunction.nativeCExportName = "";
  functions.push(move loweredFunction);
}

function lowerProgramUnchecked(
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
  let fixedArrays = Array<LoweredFixedArray>();
  let arrays = Array<LoweredArray>();
  let slices = Array<LoweredSlice>();
  let maps = Array<LoweredMap>();
  let sets = Array<LoweredSet>();
  let functionTypes = Array<LoweredFunctionType>();
  let foreignHeaders = Array<String>();
  let foreignFunctions = Array<LoweredForeignFunction>();
  let foreignResources = Array<LoweredForeignResource>();
  let objectiveCProtocolAdapters = Array<LoweredObjCProtocolAdapter>();
  let objectiveCAdapterFactories = Array<LoweredObjCAdapterFactory>();
  let objectiveCRegistrations = Array<LoweredObjCRegistration>();
  let embeddedBytes = Array<LoweredEmbeddedBytes>();
  let importedTypes = Array<LoweredImportedType>();
  const privateCollisionNames = Array<String>();
  const privateTypeCollisionNames = Array<String>();
  const genericStructUses = Array<LoweredGenericStructUse>();
  const genericMethodUses = Array<LoweredGenericMethodUse>();
  const genericFunctionUses = Array<LoweredGenericFunctionUse>();
  try appendLoweredProgram(
    program,
    "",
    inout importedTypes,
    genericStructUses,
    genericMethodUses,
    genericFunctionUses,
    evidence,
    privateCollisionNames,
    privateTypeCollisionNames,
    0,
    0,
    false,
    inout embeddedBytes,
    inout constants,
    inout fixedArrays,
    inout arrays,
    inout slices,
    inout maps,
    inout sets,
    inout functionTypes,
    inout structs,
    inout enums,
    inout functions
  );
  rewriteNativeCExportCallTargets(inout functions);
  return LoweredProgram({
    foreignHeaders,
    foreignFunctions,
    foreignResources,
    objectiveCProtocolAdapters,
    objectiveCAdapterFactories,
    objectiveCRegistrations,
    embeddedBytes,
    constants,
    fixedArrays,
    arrays,
    slices,
    maps,
    sets,
    functionTypes,
    structs,
    enums,
    functions,
  });
}

export function lowerProgram(
  in program: Program,
  in evidence: ModuleSemanticEvidence
): LoweredProgram throws String {
  const outcome = attempt lowerProgramUnchecked(program, evidence);
  return match (outcome) {
    success(lowered) => lowered;
    failure(message) => throw internalBackendFailure(
      "native lowering",
      message
    );
  };
}

export function lowerModules(
  in parsed: Array<ParsedModule>,
  in graph: ModuleGraph
): LoweredProgram throws String {
  const outcome = attempt lowerModulesIncludingTests(parsed, graph, false);
  return match (outcome) {
    success(lowered) => lowered;
    failure(message) => throw internalBackendFailure(
      "native lowering",
      message
    );
  };
}

export function lowerTestModules(
  in parsed: Array<ParsedModule>,
  in graph: ModuleGraph
): LoweredProgram throws String {
  const outcome = attempt lowerModulesIncludingTests(parsed, graph, true);
  return match (outcome) {
    success(lowered) => lowered;
    failure(message) => throw internalBackendFailure(
      "native lowering",
      message
    );
  };
}

function lowerModulesIncludingTests(
  in parsed: Array<ParsedModule>,
  in graph: ModuleGraph,
  includeTests: boolean
): LoweredProgram throws String {
  let alignedModuleIndex: usize = 0;
  while (
    alignedModuleIndex < parsed.length
    && alignedModuleIndex < graph.modules.length
  ) {
    if (parsed[alignedModuleIndex].path != graph.modules[alignedModuleIndex].path) {
      throw `native lowering module order mismatch: parsed ${parsed[alignedModuleIndex].path}, graph ${graph.modules[alignedModuleIndex].path}`;
    }
    alignedModuleIndex = alignedModuleIndex + 1;
  }
  let structs = Array<LoweredStruct>();
  let enums = Array<LoweredEnum>();
  let functions = Array<LoweredFunction>();
  let constants = Array<LoweredConstant>();
  let fixedArrays = Array<LoweredFixedArray>();
  let arrays = Array<LoweredArray>();
  let slices = Array<LoweredSlice>();
  let maps = Array<LoweredMap>();
  let sets = Array<LoweredSet>();
  let functionTypes = Array<LoweredFunctionType>();
  let foreignHeaders = Array<String>();
  let foreignFunctions = Array<LoweredForeignFunction>();
  let foreignResources = Array<LoweredForeignResource>();
  let objectiveCProtocolAdapters = Array<LoweredObjCProtocolAdapter>();
  let objectiveCAdapterFactories = Array<LoweredObjCAdapterFactory>();
  let objectiveCRegistrations = Array<LoweredObjCRegistration>();
  let embeddedBytes = Array<LoweredEmbeddedBytes>();
  const privateFunctionCollisionNames = collisionSafePrivateFunctionNames(
    parsed,
    includeTests
  );
  const privateTypeCollisionNames = collisionSafePrivateTypeNames(parsed);
  const genericStructUses = collectGenericStructUses(parsed, graph);
  let genericMethodUses = try collectGenericMethodUses(parsed, graph);
  let genericFunctionUses = try collectGenericFunctionUses(
    parsed,
    graph,
    genericMethodUses
  );
  let demandGraphChanged = true;
  while (demandGraphChanged) {
    const methodCount = genericMethodUses.length;
    const functionCount = genericFunctionUses.length;
    try closeGenericMethodDemandGraph(
      parsed,
      graph,
      genericFunctionUses,
      inout genericMethodUses
    );
    genericFunctionUses = try collectGenericFunctionUses(
      parsed,
      graph,
      genericMethodUses
    );
    demandGraphChanged = genericMethodUses.length != methodCount
      || genericFunctionUses.length != functionCount;
  }
  const deferredGenericMethodUses = Array<LoweredGenericMethodUse>();
  const deferredGenericFunctionUses = Array<LoweredGenericFunctionUse>();
  const entryIndex = graph.entry;
  for (const moduleIndex of graph.dependencyOrder) {
    const importedTypesOutcome = attempt importedTypesForModule(
      parsed[moduleIndex].program,
      graph,
      structs,
      enums,
      genericStructUses,
      moduleIndex
    );
    let importedTypes = match (importedTypesOutcome) {
      success(types) => types;
      failure(message) => throw
        `${parsed[moduleIndex].path}: native import lowering: ${message}`;
    };
    // Generic aggregate specializations can be owned by a framework module
    // while their concrete arguments are declared by a downstream consumer.
    // Preserve those canonical argument types without introducing a source
    // import cycle so constructors and ordinary methods specialize in place.
    for (const use of genericStructUses) {
      if (
        use.consumerModuleIndex != moduleIndex
        || use.ownerModuleIndex != moduleIndex
      ) continue;
      try appendGenericDemandArgumentTypes(
        parsed,
        graph,
        structs,
        enums,
        privateTypeCollisionNames,
        use.typeArguments,
        use.typeArgumentModules,
        use.typeArgumentSymbols,
        inout importedTypes
      );
    }
    try collectForeignResources(importedTypes, inout foreignResources);
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
      genericStructUses,
      deferredGenericMethodUses,
      deferredGenericFunctionUses,
      graph.modules[moduleIndex].semanticEvidence,
      privateFunctionCollisionNames,
      privateTypeCollisionNames,
      moduleIndex,
      entryIndex,
      includeTests,
      inout embeddedBytes,
      inout constants,
      inout fixedArrays,
      inout arrays,
      inout slices,
      inout maps,
      inout sets,
      inout functionTypes,
      inout structs,
      inout enums,
      inout functions
    );
    match (moduleOutcome) {
      success => try collectObjectiveCRegistrations(
        parsed,
        graph,
        privateTypeCollisionNames,
        moduleIndex,
        inout objectiveCProtocolAdapters,
        inout objectiveCAdapterFactories,
        inout objectiveCRegistrations
      );
      failure(message) => {
        const path = parsed[moduleIndex].path.copyBytes(
          0,
          parsed[moduleIndex].path.byteLength
        );
        throw `${path}: ${message}`;
      }
    }
  }
  for (const use of genericMethodUses) {
    const genericOwnerModuleIndex = use.ownerModuleIndex;
    if (genericOwnerModuleIndex >= parsed.length) {
      throw "native generic-method lowering lost its owner module";
    }
    const importedTypesOutcome = attempt importedTypesForModule(
      parsed[genericOwnerModuleIndex].program,
      graph,
      structs,
      enums,
      genericStructUses,
      genericOwnerModuleIndex
    );
    let importedTypes = match (importedTypesOutcome) {
      success(types) => types;
      failure(message) => throw
        `${parsed[genericOwnerModuleIndex].path}: generic method import lowering: ${message}`;
    };
    try appendGenericDemandArgumentTypes(
      parsed,
      graph,
      structs,
      enums,
      privateTypeCollisionNames,
      use.allTypeArguments,
      use.typeArgumentModules,
      use.typeArgumentSymbols,
      inout importedTypes
    );
    try appendConcreteGenericStructs(
      parsed[genericOwnerModuleIndex].program,
      genericStructUses,
      genericOwnerModuleIndex,
      inout importedTypes,
      inout structs
    );
    const genericOutcome = attempt appendDeferredGenericMethod(
      parsed[genericOwnerModuleIndex].program,
      parsed[genericOwnerModuleIndex].path,
      importedTypes,
      genericStructUses,
      use,
      graph.modules[genericOwnerModuleIndex].semanticEvidence,
      privateFunctionCollisionNames,
      privateTypeCollisionNames,
      genericOwnerModuleIndex,
      entryIndex,
      inout fixedArrays,
      inout arrays,
      inout slices,
      inout maps,
      inout sets,
      inout enums,
      inout functions
    );
    match (genericOutcome) {
      success => {}
      failure(message) => throw
        `${parsed[genericOwnerModuleIndex].path}: ${message}`;
    }
  }
  for (const use of genericFunctionUses) {
    const genericOwnerModuleIndex = use.ownerModuleIndex;
    if (genericOwnerModuleIndex >= parsed.length) {
      throw "native generic-function lowering lost its owner module";
    }
    const importedTypesOutcome = attempt importedTypesForModule(
      parsed[genericOwnerModuleIndex].program,
      graph,
      structs,
      enums,
      genericStructUses,
      genericOwnerModuleIndex
    );
    let importedTypes = match (importedTypesOutcome) {
      success(types) => types;
      failure(message) => throw
        `${parsed[genericOwnerModuleIndex].path}: generic function import lowering: ${message}`;
    };
    try appendGenericDemandArgumentTypes(
      parsed,
      graph,
      structs,
      enums,
      privateTypeCollisionNames,
      use.typeArguments,
      use.typeArgumentModules,
      use.typeArgumentSymbols,
      inout importedTypes
    );
    try appendConcreteGenericStructs(
      parsed[genericOwnerModuleIndex].program,
      genericStructUses,
      genericOwnerModuleIndex,
      inout importedTypes,
      inout structs
    );
    const genericOutcome = attempt appendDeferredGenericFunction(
      parsed[genericOwnerModuleIndex].program,
      parsed[genericOwnerModuleIndex].path,
      importedTypes,
      use,
      graph.modules[genericOwnerModuleIndex].semanticEvidence,
      privateFunctionCollisionNames,
      genericOwnerModuleIndex,
      entryIndex,
      inout fixedArrays,
      inout arrays,
      inout slices,
      inout maps,
      inout sets,
      inout enums,
      inout functions
    );
    match (genericOutcome) {
      success => {}
      failure(message) => throw
        `${parsed[genericOwnerModuleIndex].path}: ${message}`;
    }
  }
  rewriteNativeCExportCallTargets(inout functions);
  return LoweredProgram({
    foreignHeaders,
    foreignFunctions,
    foreignResources,
    objectiveCProtocolAdapters,
    objectiveCAdapterFactories,
    objectiveCRegistrations,
    embeddedBytes,
    constants,
    fixedArrays,
    arrays,
    slices,
    maps,
    sets,
    functionTypes,
    structs,
    enums,
    functions,
  });
}
