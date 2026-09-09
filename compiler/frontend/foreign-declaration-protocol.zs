// Versioned producer-facing foreign declaration framing.
//
// Text fields are length-prefixed UTF-8 rather than delimiter escaped, so the
// decoder can preserve arbitrary names while walking one bounded stream.

import { Map } from "std/collections";

export struct RawForeignAvailability {
  functionIndex: usize;
  overloadIndex: usize;
  availabilityIndex: usize;
  platform: Option<String>;
  introduced: Option<String>;
  deprecated: boolean;
  deprecatedVersion: Option<String>;
  obsoleted: Option<String>;
  unavailable: boolean;
  message: Option<String>;
}

export struct RawForeignConstant {
  constantIndex: usize;
  name: String;
  nativeName: String;
  typeName: String;
  sourceKind: String;
  sourceFile: Option<String>;
  sourceLine: usize;
  sourceColumn: usize;
  sourceLength: usize;
}

export struct RawForeignType {
  typeIndex: usize;
  kind: String;
  exportName: String;
  qualifiedName: String;
  typeName: String;
  nativeName: String;
  canonicalNativeName: Option<String>;
  underlyingType: String;
  flags: boolean = false;
  layout: String;
  fieldStart: usize;
  fieldCount: usize;
  sourceFile: Option<String>;
  sourceLine: usize;
  sourceColumn: usize;
  sourceLength: usize;
}

export struct RawForeignField {
  typeIndex: usize;
  fieldIndex: usize;
  name: String;
  typeName: String;
  sourceFile: Option<String>;
  sourceLine: usize;
  sourceColumn: usize;
  sourceLength: usize;
}

export struct RawForeignParameter {
  functionIndex: usize;
  overloadIndex: usize;
  parameterIndex: usize;
  name: Option<String>;
  nativeType: String;
  canonicalNativeType: Option<String>;
}

export struct RawForeignOverload {
  functionIndex: usize;
  overloadIndex: usize;
  name: String;
  nativeName: String;
  returnNativeType: String;
  returnCanonicalNativeType: Option<String>;
  variadic: boolean;
  nativeSignature: String;
  sourceFile: Option<String>;
  sourceLine: usize;
  sourceColumn: usize;
  sourceLength: usize;
  executorAffinity: Option<String>;
  parameterStart: usize;
  parameterCount: usize;
  availabilityStart: usize;
  availabilityCount: usize;
}

export struct RawForeignFunction {
  functionIndex: usize;
  name: String;
  namespaceStart: usize;
  namespaceCount: usize;
  qualifiedName: String;
  overloadStart: usize;
  overloadCount: usize;
}

export struct RawForeignObjCInterface {
  interfaceIndex: usize;
  exportName: String;
  typeName: String;
  className: String;
  superName: Option<String>;
  subclassingRestricted: boolean;
  methodStart: usize;
  methodCount: usize;
  propertyStart: usize;
  propertyCount: usize;
  sourceFile: Option<String>;
  sourceLine: usize;
  sourceColumn: usize;
  sourceLength: usize;
  executorAffinity: Option<String>;
}

export struct RawForeignObjCProperty {
  ownerIndex: usize;
  propertyIndex: usize;
  name: String;
  getter: String;
  setter: Option<String>;
  classProperty: boolean;
  readonlyProperty: boolean;
  ownership: String;
  nativeType: String;
  typeName: String;
  protocolStart: usize;
  protocolCount: usize;
  sourceFile: Option<String>;
  sourceLine: usize;
  sourceColumn: usize;
  sourceLength: usize;
  executorAffinity: Option<String>;
  availabilityStart: usize;
  availabilityCount: usize;
}

export struct RawForeignObjCPropertyAvailability {
  ownerIndex: usize;
  propertyIndex: usize;
  availabilityIndex: usize;
  platform: Option<String>;
  introduced: Option<String>;
  deprecated: boolean;
  deprecatedVersion: Option<String>;
  obsoleted: Option<String>;
  unavailable: boolean;
  message: Option<String>;
}

export struct RawForeignObjCProtocol {
  protocolIndex: usize;
  exportName: String;
  typeName: String;
  protocolName: String;
  inheritedStart: usize;
  inheritedCount: usize;
  methodStart: usize;
  methodCount: usize;
  sourceFile: Option<String>;
  sourceLine: usize;
  sourceColumn: usize;
  sourceLength: usize;
  executorAffinity: Option<String>;
}

export struct RawForeignObjCMethod {
  ownerKind: String;
  ownerIndex: usize;
  methodIndex: usize;
  selector: String;
  baseName: String;
  instance: boolean;
  returnsInstanceType: boolean;
  designatedInitializer: boolean;
  requiresSuper: boolean;
  direct: boolean;
  consumesSelf: boolean;
  variadic: boolean;
  returnNativeType: String;
  returnTypeName: String;
  required: boolean;
  sourceFile: Option<String>;
  sourceLine: usize;
  sourceColumn: usize;
  sourceLength: usize;
  executorAffinity: Option<String>;
  parameterStart: usize;
  parameterCount: usize;
  availabilityStart: usize;
  availabilityCount: usize;
  asyncCallbackParameter: Option<usize>;
  asyncResultParameter: Option<usize>;
  asyncErrorParameter: Option<usize>;
}

export struct RawForeignObjCParameter {
  ownerKind: String;
  ownerIndex: usize;
  methodIndex: usize;
  parameterIndex: usize;
  name: Option<String>;
  nativeType: String;
  typeName: String;
  consumed: boolean;
  protocolStart: usize;
  protocolCount: usize;
}

export struct RawForeignObjCAvailability {
  ownerKind: String;
  ownerIndex: usize;
  methodIndex: usize;
  availabilityIndex: usize;
  platform: Option<String>;
  introduced: Option<String>;
  deprecated: boolean;
  deprecatedVersion: Option<String>;
  obsoleted: Option<String>;
  unavailable: boolean;
  message: Option<String>;
}

export struct RawForeignModuleDeclarations {
  version: usize;
  producer: String;
  framework: Option<String>;
  objectiveC: boolean;
  cPlusPlus: boolean;
  namespaces: Array<String>;
  types: Array<RawForeignType>;
  fields: Array<RawForeignField>;
  constants: Array<RawForeignConstant>;
  functions: Array<RawForeignFunction>;
  overloads: Array<RawForeignOverload>;
  parameters: Array<RawForeignParameter>;
  availability: Array<RawForeignAvailability>;
  objectiveCInterfaces: Array<RawForeignObjCInterface>;
  objectiveCProtocols: Array<RawForeignObjCProtocol>;
  objectiveCProtocolInheritance: Array<String>;
  objectiveCMethods: Array<RawForeignObjCMethod>;
  objectiveCParameters: Array<RawForeignObjCParameter>;
  objectiveCParameterProtocols: Array<String>;
  objectiveCAvailability: Array<RawForeignObjCAvailability>;
  objectiveCProperties: Array<RawForeignObjCProperty>;
  objectiveCPropertyProtocols: Array<String>;
  objectiveCPropertyAvailability: Array<RawForeignObjCPropertyAvailability>;
  enumTypeIndices: Map<String, usize>;
  recordTypeIndices: Map<String, usize>;
  scalarTypeIndices: Map<String, usize>;
  mutableRecordPointerIndices: Map<String, usize>;
  constRecordPointerIndices: Map<String, usize>;
  objectiveCInterfaceIndices: Map<String, usize>;
}

struct ForeignWireCursor {
  batch: String;
  offset: usize;
}

function emptyRawForeignModule(): RawForeignModuleDeclarations {
  return RawForeignModuleDeclarations({
    version: 0,
    producer: "",
    framework: Option<String>.none,
    objectiveC: false,
    cPlusPlus: false,
    namespaces: Array<String>(),
    types: Array<RawForeignType>(),
    fields: Array<RawForeignField>(),
    constants: Array<RawForeignConstant>(),
    functions: Array<RawForeignFunction>(),
    overloads: Array<RawForeignOverload>(),
    parameters: Array<RawForeignParameter>(),
    availability: Array<RawForeignAvailability>(),
    objectiveCInterfaces: Array<RawForeignObjCInterface>(),
    objectiveCProtocols: Array<RawForeignObjCProtocol>(),
    objectiveCProtocolInheritance: Array<String>(),
    objectiveCMethods: Array<RawForeignObjCMethod>(),
    objectiveCParameters: Array<RawForeignObjCParameter>(),
    objectiveCParameterProtocols: Array<String>(),
    objectiveCAvailability: Array<RawForeignObjCAvailability>(),
    objectiveCProperties: Array<RawForeignObjCProperty>(),
    objectiveCPropertyProtocols: Array<String>(),
    objectiveCPropertyAvailability:
      Array<RawForeignObjCPropertyAvailability>(),
    enumTypeIndices: Map<String, usize>(),
    recordTypeIndices: Map<String, usize>(),
    scalarTypeIndices: Map<String, usize>(),
    mutableRecordPointerIndices: Map<String, usize>(),
    constRecordPointerIndices: Map<String, usize>(),
    objectiveCInterfaceIndices: Map<String, usize>(),
  });
}

function indexName(
  inout indices: Map<String, usize>,
  in name: String,
  index: usize
): void {
  if (name.byteLength == 0 || indices.has(name)) return;
  indices.set(copy name, index);
}

function indexedRecordValueName(in name: String): String {
  return `struct ${name}`;
}

function indexedRecordPointerName(
  in name: String,
  constant: boolean,
  tagged: boolean
): String {
  let prefix = "";
  if (constant) prefix = "const ";
  const tag = tagged ? "struct " : "";
  return `${prefix}${tag}${name} *`;
}

function buildForeignTypeIndices(
  inout module: RawForeignModuleDeclarations
): void {
  let index: usize = 0;
  while (index < module.types.length) {
    const kind = copy module.types[index].kind;
    const nativeName = copy module.types[index].nativeName;
    const exportName = copy module.types[index].exportName;
    const qualifiedName = copy module.types[index].qualifiedName;
    const typeName = copy module.types[index].typeName;
    if (kind == "enum") {
      indexName(inout module.enumTypeIndices, nativeName, index);
      indexName(inout module.enumTypeIndices, exportName, index);
      indexName(inout module.enumTypeIndices, qualifiedName, index);
    } else if (kind == "scalar") {
      indexName(inout module.scalarTypeIndices, nativeName, index);
      indexName(inout module.scalarTypeIndices, exportName, index);
      indexName(inout module.scalarTypeIndices, qualifiedName, index);
      indexName(inout module.scalarTypeIndices, typeName, index);
    } else if (kind == "record") {
      indexName(inout module.recordTypeIndices, nativeName, index);
      indexName(inout module.recordTypeIndices, exportName, index);
      indexName(inout module.recordTypeIndices, qualifiedName, index);
      indexName(inout module.recordTypeIndices, typeName, index);
      const taggedNative = indexedRecordValueName(nativeName);
      const taggedExport = indexedRecordValueName(exportName);
      indexName(inout module.recordTypeIndices, taggedNative, index);
      indexName(inout module.recordTypeIndices, taggedExport, index);

      const mutableNative = indexedRecordPointerName(
        nativeName,
        false,
        false
      );
      const mutableExport = indexedRecordPointerName(
        exportName,
        false,
        false
      );
      const mutableTagged = indexedRecordPointerName(
        nativeName,
        false,
        true
      );
      indexName(
        inout module.mutableRecordPointerIndices,
        mutableNative,
        index
      );
      indexName(
        inout module.mutableRecordPointerIndices,
        mutableExport,
        index
      );
      indexName(
        inout module.mutableRecordPointerIndices,
        mutableTagged,
        index
      );

      const constNative = indexedRecordPointerName(
        nativeName,
        true,
        false
      );
      const constExport = indexedRecordPointerName(
        exportName,
        true,
        false
      );
      const constTagged = indexedRecordPointerName(
        nativeName,
        true,
        true
      );
      indexName(
        inout module.constRecordPointerIndices,
        constNative,
        index
      );
      indexName(
        inout module.constRecordPointerIndices,
        constExport,
        index
      );
      indexName(
        inout module.constRecordPointerIndices,
        constTagged,
        index
      );
    }
    index = index + 1;
  }
  index = 0;
  while (index < module.objectiveCInterfaces.length) {
    const className = copy module.objectiveCInterfaces[index].className;
    indexName(
      inout module.objectiveCInterfaceIndices,
      className,
      index
    );
    index = index + 1;
  }
}

function hexValue(byte: u8): usize throws String {
  if (byte == 48) return 0;
  if (byte == 49) return 1;
  if (byte == 50) return 2;
  if (byte == 51) return 3;
  if (byte == 52) return 4;
  if (byte == 53) return 5;
  if (byte == 54) return 6;
  if (byte == 55) return 7;
  if (byte == 56) return 8;
  if (byte == 57) return 9;
  if (byte == 97) return 10;
  if (byte == 98) return 11;
  if (byte == 99) return 12;
  if (byte == 100) return 13;
  if (byte == 101) return 14;
  if (byte == 102) return 15;
  throw "foreign declaration stream contains an invalid hexadecimal integer";
}

function readHexUsize(inout cursor: ForeignWireCursor): usize throws String {
  const start = cursor.offset;
  const end = start + 16;
  if (end > cursor.batch.byteLength) {
    throw "foreign declaration stream ended inside an integer";
  }
  let value: usize = 0;
  let index = start;
  while (index < end) {
    const byte = cursor.batch.byteAt(index);
    const digit = try hexValue(byte);
    value = (value << 4) | digit;
    index = index + 1;
  }
  cursor.offset = end;
  return value;
}

function readText(inout cursor: ForeignWireCursor): String throws String {
  const length = try readHexUsize(inout cursor);
  const start = cursor.offset;
  const end = start + length;
  if (end < start || end > cursor.batch.byteLength) {
    throw "foreign declaration stream ended inside UTF-8 text";
  }
  cursor.offset = end;
  return cursor.batch.copyBytes(start, end);
}

function readOptionalText(
  inout cursor: ForeignWireCursor
): Option<String> throws String {
  if (cursor.offset >= cursor.batch.byteLength) {
    throw "foreign declaration stream ended before optional text";
  }
  const present = cursor.batch.byteAt(cursor.offset);
  cursor.offset = cursor.offset + 1;
  if (present == 48) return Option<String>.none;
  if (present != 49) {
    throw "foreign declaration stream has an invalid optional-text flag";
  }
  const value = try readText(inout cursor);
  return Option.some(value);
}

function readBoolean(inout cursor: ForeignWireCursor): boolean throws String {
  if (cursor.offset >= cursor.batch.byteLength) {
    throw "foreign declaration stream ended before a boolean";
  }
  const value = cursor.batch.byteAt(cursor.offset);
  cursor.offset = cursor.offset + 1;
  if (value == 48) return false;
  if (value == 49) return true;
  throw "foreign declaration stream has an invalid boolean";
}

function readOptionalUsize(
  inout cursor: ForeignWireCursor
): Option<usize> throws String {
  if (cursor.offset >= cursor.batch.byteLength) {
    throw "foreign declaration stream ended before optional integer";
  }
  const present = cursor.batch.byteAt(cursor.offset);
  cursor.offset = cursor.offset + 1;
  if (present == 48) return Option<usize>.none;
  if (present != 49) {
    throw "foreign declaration stream has an invalid optional-integer flag";
  }
  const value = try readHexUsize(inout cursor);
  return Option.some(value);
}

function expectByte(
  inout cursor: ForeignWireCursor,
  expected: u8,
  in description: String
): void throws String {
  if (
    cursor.offset >= cursor.batch.byteLength
    || cursor.batch.byteAt(cursor.offset) != expected
  ) {
    throw `foreign declaration stream expected ${description}`;
  }
  cursor.offset = cursor.offset + 1;
}

function expectLiteral(
  inout cursor: ForeignWireCursor,
  in literal: String
): void throws String {
  let index: usize = 0;
  while (index < literal.byteLength) {
    if (
      cursor.offset >= cursor.batch.byteLength
      || cursor.batch.byteAt(cursor.offset) != literal.byteAt(index)
    ) {
      throw `foreign declaration stream expected ${literal}`;
    }
    cursor.offset = cursor.offset + 1;
    index = index + 1;
  }
}

function endRecord(inout cursor: ForeignWireCursor): void throws String {
  try expectByte(inout cursor, 10, "a record terminator");
}

function validateFunctionReference(
  in module: RawForeignModuleDeclarations,
  functionIndex: usize,
  overloadIndex: usize
): void throws String {
  if (functionIndex >= module.functions.length) {
    throw "foreign declaration stream references an unknown function";
  }
  const overloadStart = module.functions[functionIndex].overloadStart;
  const overloadCount = module.functions[functionIndex].overloadCount;
  if (
    overloadIndex >= overloadCount
    || overloadStart + overloadIndex != module.overloads.length
  ) {
    throw "foreign declaration stream contains an out-of-order overload";
  }
}

function appendType(
  inout cursor: ForeignWireCursor,
  inout module: RawForeignModuleDeclarations
): void throws String {
  const typeIndex = try readHexUsize(inout cursor);
  if (typeIndex != module.types.length) {
    throw "foreign declaration stream contains an out-of-order type";
  }
  const kind = try readText(inout cursor);
  if (kind != "enum" && kind != "record" && kind != "scalar") {
    throw "foreign declaration stream contains an unsupported named type";
  }
  const exportName = try readText(inout cursor);
  const qualifiedName = try readText(inout cursor);
  const typeName = try readText(inout cursor);
  const nativeName = try readText(inout cursor);
  const canonicalNativeName = try readOptionalText(inout cursor);
  const underlyingType = try readText(inout cursor);
  const flags = try readBoolean(inout cursor);
  const layout = try readText(inout cursor);
  const sourceFile = try readOptionalText(inout cursor);
  const sourceLine = try readHexUsize(inout cursor);
  const sourceColumn = try readHexUsize(inout cursor);
  const sourceLength = try readHexUsize(inout cursor);
  const fieldCount = try readHexUsize(inout cursor);
  if (
    (
      (kind == "enum" || kind == "scalar")
      && (layout.byteLength > 0 || fieldCount > 0)
    )
    || (
      kind == "record"
      && layout != "struct"
      && layout != "union"
    )
  ) {
    throw "foreign declaration stream contains invalid named-type details";
  }
  module.types.push(RawForeignType({
    typeIndex,
    kind,
    exportName,
    qualifiedName,
    typeName,
    nativeName,
    canonicalNativeName,
    underlyingType,
    flags,
    layout,
    fieldStart: module.fields.length,
    fieldCount,
    sourceFile,
    sourceLine,
    sourceColumn,
    sourceLength,
  }));
  try endRecord(inout cursor);
}

function appendField(
  inout cursor: ForeignWireCursor,
  inout module: RawForeignModuleDeclarations
): void throws String {
  const typeIndex = try readHexUsize(inout cursor);
  const fieldIndex = try readHexUsize(inout cursor);
  if (typeIndex >= module.types.length) {
    throw "foreign declaration stream references an unknown field owner";
  }
  const owner = view module.types[typeIndex];
  if (
    owner.kind != "record"
    || typeIndex + 1 != module.types.length
    || fieldIndex >= owner.fieldCount
    || owner.fieldStart + fieldIndex != module.fields.length
  ) {
    throw "foreign declaration stream contains an out-of-order field";
  }
  const name = try readText(inout cursor);
  const typeName = try readText(inout cursor);
  const sourceFile = try readOptionalText(inout cursor);
  const sourceLine = try readHexUsize(inout cursor);
  const sourceColumn = try readHexUsize(inout cursor);
  const sourceLength = try readHexUsize(inout cursor);
  module.fields.push(RawForeignField({
    typeIndex,
    fieldIndex,
    name,
    typeName,
    sourceFile,
    sourceLine,
    sourceColumn,
    sourceLength,
  }));
  try endRecord(inout cursor);
}

function appendConstant(
  inout cursor: ForeignWireCursor,
  inout module: RawForeignModuleDeclarations
): void throws String {
  const constantIndex = try readHexUsize(inout cursor);
  if (constantIndex != module.constants.length) {
    throw "foreign declaration stream contains an out-of-order constant";
  }
  const name = try readText(inout cursor);
  const nativeName = try readText(inout cursor);
  const typeName = try readText(inout cursor);
  const sourceKind = try readText(inout cursor);
  if (
    sourceKind != "enum"
    && sourceKind != "variable"
    && sourceKind != "macro"
  ) {
    throw "foreign declaration stream contains an unknown constant source kind";
  }
  const sourceFile = try readOptionalText(inout cursor);
  const sourceLine = try readHexUsize(inout cursor);
  const sourceColumn = try readHexUsize(inout cursor);
  const sourceLength = try readHexUsize(inout cursor);
  module.constants.push(RawForeignConstant({
    constantIndex,
    name,
    nativeName,
    typeName,
    sourceKind,
    sourceFile,
    sourceLine,
    sourceColumn,
    sourceLength,
  }));
  try endRecord(inout cursor);
}

function appendFunction(
  inout cursor: ForeignWireCursor,
  inout module: RawForeignModuleDeclarations
): void throws String {
  const functionIndex = try readHexUsize(inout cursor);
  if (functionIndex != module.functions.length) {
    throw "foreign declaration stream contains an out-of-order function";
  }
  const name = try readText(inout cursor);
  const namespaceCount = try readHexUsize(inout cursor);
  const namespaceStart = module.namespaces.length;
  let namespaceIndex: usize = 0;
  while (namespaceIndex < namespaceCount) {
    const namespace = try readText(inout cursor);
    module.namespaces.push(namespace);
    namespaceIndex = namespaceIndex + 1;
  }
  const qualifiedName = try readText(inout cursor);
  const overloadCount = try readHexUsize(inout cursor);
  module.functions.push(RawForeignFunction({
    functionIndex,
    name,
    namespaceStart,
    namespaceCount,
    qualifiedName,
    overloadStart: module.overloads.length,
    overloadCount,
  }));
  try endRecord(inout cursor);
}

function appendOverload(
  inout cursor: ForeignWireCursor,
  inout module: RawForeignModuleDeclarations
): void throws String {
  const functionIndex = try readHexUsize(inout cursor);
  const overloadIndex = try readHexUsize(inout cursor);
  try validateFunctionReference(module, functionIndex, overloadIndex);
  const name = try readText(inout cursor);
  const nativeName = try readText(inout cursor);
  const returnNativeType = try readText(inout cursor);
  const returnCanonicalNativeType = try readOptionalText(inout cursor);
  const variadic = try readBoolean(inout cursor);
  const nativeSignature = try readText(inout cursor);
  const sourceFile = try readOptionalText(inout cursor);
  const sourceLine = try readHexUsize(inout cursor);
  const sourceColumn = try readHexUsize(inout cursor);
  const sourceLength = try readHexUsize(inout cursor);
  const executorAffinity = try readOptionalText(inout cursor);
  const parameterCount = try readHexUsize(inout cursor);
  const availabilityCount = try readHexUsize(inout cursor);
  module.overloads.push(RawForeignOverload({
    functionIndex,
    overloadIndex,
    name,
    nativeName,
    returnNativeType,
    returnCanonicalNativeType,
    variadic,
    nativeSignature,
    sourceFile,
    sourceLine,
    sourceColumn,
    sourceLength,
    executorAffinity,
    parameterStart: module.parameters.length,
    parameterCount,
    availabilityStart: module.availability.length,
    availabilityCount,
  }));
  try endRecord(inout cursor);
}

function appendParameter(
  inout cursor: ForeignWireCursor,
  inout module: RawForeignModuleDeclarations
): void throws String {
  const functionIndex = try readHexUsize(inout cursor);
  const overloadIndex = try readHexUsize(inout cursor);
  const parameterIndex = try readHexUsize(inout cursor);
  if (module.overloads.length == 0) {
    throw "foreign declaration stream contains a parameter before its overload";
  }
  const currentOverload = module.overloads.length - 1;
  const expectedFunction = module.overloads[currentOverload].functionIndex;
  const expectedOverload = module.overloads[currentOverload].overloadIndex;
  const parameterCount = module.overloads[currentOverload].parameterCount;
  const parameterStart = module.overloads[currentOverload].parameterStart;
  if (
    expectedFunction != functionIndex
    || expectedOverload != overloadIndex
    || parameterIndex >= parameterCount
    || parameterStart + parameterIndex != module.parameters.length
  ) {
    throw "foreign declaration stream contains an out-of-order parameter";
  }
  const name = try readOptionalText(inout cursor);
  const nativeType = try readText(inout cursor);
  const canonicalNativeType = try readOptionalText(inout cursor);
  module.parameters.push(RawForeignParameter({
    functionIndex,
    overloadIndex,
    parameterIndex,
    name,
    nativeType,
    canonicalNativeType,
  }));
  try endRecord(inout cursor);
}

function appendAvailability(
  inout cursor: ForeignWireCursor,
  inout module: RawForeignModuleDeclarations
): void throws String {
  const functionIndex = try readHexUsize(inout cursor);
  const overloadIndex = try readHexUsize(inout cursor);
  const availabilityIndex = try readHexUsize(inout cursor);
  if (module.overloads.length == 0) {
    throw "foreign declaration stream contains availability before an overload";
  }
  const currentOverload = module.overloads.length - 1;
  const expectedFunction = module.overloads[currentOverload].functionIndex;
  const expectedOverload = module.overloads[currentOverload].overloadIndex;
  const availabilityCount = module.overloads[currentOverload].availabilityCount;
  const availabilityStart = module.overloads[currentOverload].availabilityStart;
  if (
    expectedFunction != functionIndex
    || expectedOverload != overloadIndex
    || availabilityIndex >= availabilityCount
    || availabilityStart + availabilityIndex != module.availability.length
  ) {
    throw "foreign declaration stream contains out-of-order availability";
  }
  const platform = try readOptionalText(inout cursor);
  const introduced = try readOptionalText(inout cursor);
  const deprecated = try readBoolean(inout cursor);
  const deprecatedVersion = try readOptionalText(inout cursor);
  const obsoleted = try readOptionalText(inout cursor);
  const unavailable = try readBoolean(inout cursor);
  const message = try readOptionalText(inout cursor);
  module.availability.push(RawForeignAvailability({
    functionIndex,
    overloadIndex,
    availabilityIndex,
    platform,
    introduced,
    deprecated,
    deprecatedVersion,
    obsoleted,
    unavailable,
    message,
  }));
  try endRecord(inout cursor);
}

function appendObjCProtocol(
  inout cursor: ForeignWireCursor,
  inout module: RawForeignModuleDeclarations
): void throws String {
  const protocolIndex = try readHexUsize(inout cursor);
  if (protocolIndex != module.objectiveCProtocols.length) {
    throw "foreign declaration stream contains an out-of-order Objective-C protocol";
  }
  const exportName = try readText(inout cursor);
  const typeName = try readText(inout cursor);
  const protocolName = try readText(inout cursor);
  const inheritedCount = try readHexUsize(inout cursor);
  const inheritedStart = module.objectiveCProtocolInheritance.length;
  let inheritedIndex: usize = 0;
  while (inheritedIndex < inheritedCount) {
    const inherited = try readText(inout cursor);
    module.objectiveCProtocolInheritance.push(inherited);
    inheritedIndex = inheritedIndex + 1;
  }
  const sourceFile = try readOptionalText(inout cursor);
  const sourceLine = try readHexUsize(inout cursor);
  const sourceColumn = try readHexUsize(inout cursor);
  const sourceLength = try readHexUsize(inout cursor);
  const executorAffinity = try readOptionalText(inout cursor);
  const methodCount = try readHexUsize(inout cursor);
  module.objectiveCProtocols.push(RawForeignObjCProtocol({
    protocolIndex,
    exportName,
    typeName,
    protocolName,
    inheritedStart,
    inheritedCount,
    methodStart: module.objectiveCMethods.length,
    methodCount,
    sourceFile,
    sourceLine,
    sourceColumn,
    sourceLength,
    executorAffinity,
  }));
  try endRecord(inout cursor);
}

function appendObjCInterface(
  inout cursor: ForeignWireCursor,
  inout module: RawForeignModuleDeclarations
): void throws String {
  const interfaceIndex = try readHexUsize(inout cursor);
  if (interfaceIndex != module.objectiveCInterfaces.length) {
    throw "foreign declaration stream contains an out-of-order Objective-C interface";
  }
  const exportName = try readText(inout cursor);
  const typeName = try readText(inout cursor);
  const className = try readText(inout cursor);
  const superName = try readOptionalText(inout cursor);
  const subclassingRestricted = try readBoolean(inout cursor);
  const sourceFile = try readOptionalText(inout cursor);
  const sourceLine = try readHexUsize(inout cursor);
  const sourceColumn = try readHexUsize(inout cursor);
  const sourceLength = try readHexUsize(inout cursor);
  const executorAffinity = try readOptionalText(inout cursor);
  const methodCount = try readHexUsize(inout cursor);
  const propertyCount = try readHexUsize(inout cursor);
  module.objectiveCInterfaces.push(RawForeignObjCInterface({
    interfaceIndex,
    exportName,
    typeName,
    className,
    superName,
    subclassingRestricted,
    methodStart: module.objectiveCMethods.length,
    methodCount,
    propertyStart: module.objectiveCProperties.length,
    propertyCount,
    sourceFile,
    sourceLine,
    sourceColumn,
    sourceLength,
    executorAffinity,
  }));
  try endRecord(inout cursor);
}

function validateObjCMethodOwner(
  in module: RawForeignModuleDeclarations,
  in ownerKind: String,
  ownerIndex: usize,
  methodIndex: usize
): void throws String {
  if (ownerKind == "protocol") {
    if (ownerIndex >= module.objectiveCProtocols.length) {
      throw "foreign declaration stream references an unknown Objective-C protocol";
    }
    const owner = view module.objectiveCProtocols[ownerIndex];
    if (
      ownerIndex + 1 != module.objectiveCProtocols.length
      || methodIndex >= owner.methodCount
      || owner.methodStart + methodIndex != module.objectiveCMethods.length
    ) {
      throw "foreign declaration stream contains an out-of-order Objective-C protocol method";
    }
    return;
  }
  if (ownerKind == "interface") {
    if (ownerIndex >= module.objectiveCInterfaces.length) {
      throw "foreign declaration stream references an unknown Objective-C interface";
    }
    const owner = view module.objectiveCInterfaces[ownerIndex];
    if (
      ownerIndex + 1 != module.objectiveCInterfaces.length
      || methodIndex >= owner.methodCount
      || owner.methodStart + methodIndex != module.objectiveCMethods.length
    ) {
      throw "foreign declaration stream contains an out-of-order Objective-C interface method";
    }
    return;
  }
  throw "foreign declaration stream contains an unknown Objective-C method owner kind";
}

function appendObjCMethod(
  inout cursor: ForeignWireCursor,
  inout module: RawForeignModuleDeclarations
): void throws String {
  const ownerKind = try readText(inout cursor);
  const ownerIndex = try readHexUsize(inout cursor);
  const methodIndex = try readHexUsize(inout cursor);
  try validateObjCMethodOwner(module, ownerKind, ownerIndex, methodIndex);
  const selector = try readText(inout cursor);
  const baseName = try readText(inout cursor);
  const instance = try readBoolean(inout cursor);
  const returnsInstanceType = try readBoolean(inout cursor);
  const designatedInitializer = try readBoolean(inout cursor);
  const requiresSuper = try readBoolean(inout cursor);
  const direct = try readBoolean(inout cursor);
  const consumesSelf = try readBoolean(inout cursor);
  const variadic = try readBoolean(inout cursor);
  const returnNativeType = try readText(inout cursor);
  const returnTypeName = try readText(inout cursor);
  const required = try readBoolean(inout cursor);
  const sourceFile = try readOptionalText(inout cursor);
  const sourceLine = try readHexUsize(inout cursor);
  const sourceColumn = try readHexUsize(inout cursor);
  const sourceLength = try readHexUsize(inout cursor);
  const executorAffinity = try readOptionalText(inout cursor);
  const parameterCount = try readHexUsize(inout cursor);
  const availabilityCount = try readHexUsize(inout cursor);
  const asyncCallbackParameter = try readOptionalUsize(inout cursor);
  const asyncResultParameter = try readOptionalUsize(inout cursor);
  const asyncErrorParameter = try readOptionalUsize(inout cursor);
  module.objectiveCMethods.push(RawForeignObjCMethod({
    ownerKind,
    ownerIndex,
    methodIndex,
    selector,
    baseName,
    instance,
    returnsInstanceType,
    designatedInitializer,
    requiresSuper,
    direct,
    consumesSelf,
    variadic,
    returnNativeType,
    returnTypeName,
    required,
    sourceFile,
    sourceLine,
    sourceColumn,
    sourceLength,
    executorAffinity,
    parameterStart: module.objectiveCParameters.length,
    parameterCount,
    availabilityStart: module.objectiveCAvailability.length,
    availabilityCount,
    asyncCallbackParameter,
    asyncResultParameter,
    asyncErrorParameter,
  }));
  try endRecord(inout cursor);
}

function appendObjCParameter(
  inout cursor: ForeignWireCursor,
  inout module: RawForeignModuleDeclarations
): void throws String {
  const ownerKind = try readText(inout cursor);
  const ownerIndex = try readHexUsize(inout cursor);
  const methodIndex = try readHexUsize(inout cursor);
  const parameterIndex = try readHexUsize(inout cursor);
  if (module.objectiveCMethods.length == 0) {
    throw "foreign declaration stream contains an Objective-C parameter before its method";
  }
  const method = view module.objectiveCMethods[module.objectiveCMethods.length - 1];
  if (
    method.ownerKind != ownerKind
    || method.ownerIndex != ownerIndex
    || method.methodIndex != methodIndex
    || parameterIndex >= method.parameterCount
    || method.parameterStart + parameterIndex != module.objectiveCParameters.length
  ) {
    throw "foreign declaration stream contains an out-of-order Objective-C parameter";
  }
  const name = try readOptionalText(inout cursor);
  const nativeType = try readText(inout cursor);
  const typeName = try readText(inout cursor);
  const consumed = try readBoolean(inout cursor);
  const protocolCount = try readHexUsize(inout cursor);
  const protocolStart = module.objectiveCParameterProtocols.length;
  let protocolIndex: usize = 0;
  while (protocolIndex < protocolCount) {
    const protocol = try readText(inout cursor);
    module.objectiveCParameterProtocols.push(protocol);
    protocolIndex = protocolIndex + 1;
  }
  module.objectiveCParameters.push(RawForeignObjCParameter({
    ownerKind,
    ownerIndex,
    methodIndex,
    parameterIndex,
    name,
    nativeType,
    typeName,
    consumed,
    protocolStart,
    protocolCount,
  }));
  try endRecord(inout cursor);
}

function appendObjCAvailability(
  inout cursor: ForeignWireCursor,
  inout module: RawForeignModuleDeclarations
): void throws String {
  const ownerKind = try readText(inout cursor);
  const ownerIndex = try readHexUsize(inout cursor);
  const methodIndex = try readHexUsize(inout cursor);
  const availabilityIndex = try readHexUsize(inout cursor);
  if (module.objectiveCMethods.length == 0) {
    throw "foreign declaration stream contains Objective-C availability before its method";
  }
  const method = view module.objectiveCMethods[module.objectiveCMethods.length - 1];
  if (
    method.ownerKind != ownerKind
    || method.ownerIndex != ownerIndex
    || method.methodIndex != methodIndex
    || availabilityIndex >= method.availabilityCount
    || method.availabilityStart + availabilityIndex
      != module.objectiveCAvailability.length
  ) {
    throw "foreign declaration stream contains out-of-order Objective-C availability";
  }
  const platform = try readOptionalText(inout cursor);
  const introduced = try readOptionalText(inout cursor);
  const deprecated = try readBoolean(inout cursor);
  const deprecatedVersion = try readOptionalText(inout cursor);
  const obsoleted = try readOptionalText(inout cursor);
  const unavailable = try readBoolean(inout cursor);
  const message = try readOptionalText(inout cursor);
  module.objectiveCAvailability.push(RawForeignObjCAvailability({
    ownerKind,
    ownerIndex,
    methodIndex,
    availabilityIndex,
    platform,
    introduced,
    deprecated,
    deprecatedVersion,
    obsoleted,
    unavailable,
    message,
  }));
  try endRecord(inout cursor);
}

function appendObjCProperty(
  inout cursor: ForeignWireCursor,
  inout module: RawForeignModuleDeclarations
): void throws String {
  const ownerIndex = try readHexUsize(inout cursor);
  const propertyIndex = try readHexUsize(inout cursor);
  if (ownerIndex >= module.objectiveCInterfaces.length) {
    throw "foreign declaration stream references an unknown Objective-C property owner";
  }
  const owner = view module.objectiveCInterfaces[ownerIndex];
  if (
    ownerIndex + 1 != module.objectiveCInterfaces.length
    || propertyIndex >= owner.propertyCount
    || owner.propertyStart + propertyIndex
      != module.objectiveCProperties.length
  ) {
    throw "foreign declaration stream contains an out-of-order Objective-C property";
  }
  const name = try readText(inout cursor);
  const getter = try readText(inout cursor);
  const setter = try readOptionalText(inout cursor);
  const classProperty = try readBoolean(inout cursor);
  const readonlyProperty = try readBoolean(inout cursor);
  const ownership = try readText(inout cursor);
  const nativeType = try readText(inout cursor);
  const typeName = try readText(inout cursor);
  const protocolCount = try readHexUsize(inout cursor);
  const protocolStart = module.objectiveCPropertyProtocols.length;
  let protocolIndex: usize = 0;
  while (protocolIndex < protocolCount) {
    const protocol = try readText(inout cursor);
    module.objectiveCPropertyProtocols.push(move protocol);
    protocolIndex = protocolIndex + 1;
  }
  const sourceFile = try readOptionalText(inout cursor);
  const sourceLine = try readHexUsize(inout cursor);
  const sourceColumn = try readHexUsize(inout cursor);
  const sourceLength = try readHexUsize(inout cursor);
  const executorAffinity = try readOptionalText(inout cursor);
  const availabilityCount = try readHexUsize(inout cursor);
  module.objectiveCProperties.push(RawForeignObjCProperty({
    ownerIndex,
    propertyIndex,
    name,
    getter,
    setter,
    classProperty,
    readonlyProperty,
    ownership,
    nativeType,
    typeName,
    protocolStart,
    protocolCount,
    sourceFile,
    sourceLine,
    sourceColumn,
    sourceLength,
    executorAffinity,
    availabilityStart: module.objectiveCPropertyAvailability.length,
    availabilityCount,
  }));
  try endRecord(inout cursor);
}

function appendObjCPropertyAvailability(
  inout cursor: ForeignWireCursor,
  inout module: RawForeignModuleDeclarations
): void throws String {
  const ownerIndex = try readHexUsize(inout cursor);
  const propertyIndex = try readHexUsize(inout cursor);
  const availabilityIndex = try readHexUsize(inout cursor);
  if (module.objectiveCProperties.length == 0) {
    throw "foreign declaration stream contains Objective-C property availability before its property";
  }
  const property = view module.objectiveCProperties[
    module.objectiveCProperties.length - 1
  ];
  if (
    property.ownerIndex != ownerIndex
    || property.propertyIndex != propertyIndex
    || availabilityIndex >= property.availabilityCount
    || property.availabilityStart + availabilityIndex
      != module.objectiveCPropertyAvailability.length
  ) {
    throw "foreign declaration stream contains out-of-order Objective-C property availability";
  }
  const platform = try readOptionalText(inout cursor);
  const introduced = try readOptionalText(inout cursor);
  const deprecated = try readBoolean(inout cursor);
  const deprecatedVersion = try readOptionalText(inout cursor);
  const obsoleted = try readOptionalText(inout cursor);
  const unavailable = try readBoolean(inout cursor);
  const message = try readOptionalText(inout cursor);
  module.objectiveCPropertyAvailability.push(
    RawForeignObjCPropertyAvailability({
      ownerIndex,
      propertyIndex,
      availabilityIndex,
      platform,
      introduced,
      deprecated,
      deprecatedVersion,
      obsoleted,
      unavailable,
      message,
    })
  );
  try endRecord(inout cursor);
}

function validateCompletedModule(
  in module: RawForeignModuleDeclarations
): void throws String {
  for (const declaration of module.types) {
    if (declaration.fieldStart + declaration.fieldCount > module.fields.length) {
      throw "foreign declaration stream ended before all record fields";
    }
    let fieldIndex: usize = 0;
    while (fieldIndex < declaration.fieldCount) {
      const field = view module.fields[declaration.fieldStart + fieldIndex];
      if (
        field.typeIndex != declaration.typeIndex
        || field.fieldIndex != fieldIndex
      ) {
        throw "foreign declaration stream contains mismatched record fields";
      }
      fieldIndex = fieldIndex + 1;
    }
  }
  for (const declaration of module.functions) {
    if (
      declaration.overloadStart + declaration.overloadCount
      > module.overloads.length
    ) {
      throw "foreign declaration stream ended before all function overloads";
    }
  }
  for (const overload of module.overloads) {
    if (overload.parameterStart + overload.parameterCount > module.parameters.length) {
      throw "foreign declaration stream ended before all overload parameters";
    }
    if (
      overload.availabilityStart + overload.availabilityCount
      > module.availability.length
    ) {
      throw "foreign declaration stream ended before all availability records";
    }
  }
  for (const declaration of module.objectiveCProtocols) {
    if (
      declaration.inheritedStart + declaration.inheritedCount
        > module.objectiveCProtocolInheritance.length
      || declaration.methodStart + declaration.methodCount
        > module.objectiveCMethods.length
    ) {
      throw "foreign declaration stream ended inside an Objective-C protocol";
    }
  }
  for (const declaration of module.objectiveCInterfaces) {
    if (
      declaration.methodStart + declaration.methodCount
        > module.objectiveCMethods.length
      || declaration.propertyStart + declaration.propertyCount
        > module.objectiveCProperties.length
    ) {
      throw "foreign declaration stream ended inside an Objective-C interface";
    }
  }
  for (const method of module.objectiveCMethods) {
    if (
      method.parameterStart + method.parameterCount
        > module.objectiveCParameters.length
      || method.availabilityStart + method.availabilityCount
        > module.objectiveCAvailability.length
    ) {
      throw "foreign declaration stream ended inside an Objective-C method";
    }
  }
  for (const parameter of module.objectiveCParameters) {
    if (
      parameter.protocolStart + parameter.protocolCount
        > module.objectiveCParameterProtocols.length
    ) {
      throw "foreign declaration stream ended inside Objective-C protocol qualifiers";
    }
  }
  for (const property of module.objectiveCProperties) {
    if (
      property.protocolStart + property.protocolCount
        > module.objectiveCPropertyProtocols.length
      || property.availabilityStart + property.availabilityCount
        > module.objectiveCPropertyAvailability.length
    ) {
      throw "foreign declaration stream ended inside an Objective-C property";
    }
  }
}

export function decodeRawForeignDeclarations(
  batch: String
): RawForeignModuleDeclarations throws String {
  let cursor = ForeignWireCursor({
    batch,
    offset: 0,
  });
  try expectLiteral(inout cursor, "ZFDCL");
  let module = emptyRawForeignModule();
  module.version = try readHexUsize(inout cursor);
  if (module.version != 14) {
    throw `unsupported foreign declaration stream version ${module.version}`;
  }
  try endRecord(inout cursor);
  try expectByte(inout cursor, 77, "a module record");
  module.producer = try readText(inout cursor);
  module.framework = try readOptionalText(inout cursor);
  module.objectiveC = try readBoolean(inout cursor);
  module.cPlusPlus = try readBoolean(inout cursor);
  try endRecord(inout cursor);

  while (cursor.offset < cursor.batch.byteLength) {
    const tag = cursor.batch.byteAt(cursor.offset);
    cursor.offset = cursor.offset + 1;
    if (tag == 84) {
      try appendType(inout cursor, inout module);
    } else if (tag == 68) {
      try appendField(inout cursor, inout module);
    } else if (tag == 67) {
      try appendConstant(inout cursor, inout module);
    } else if (tag == 70) {
      try appendFunction(inout cursor, inout module);
    } else if (tag == 79) {
      try appendOverload(inout cursor, inout module);
    } else if (tag == 80) {
      try appendParameter(inout cursor, inout module);
    } else if (tag == 65) {
      try appendAvailability(inout cursor, inout module);
    } else if (tag == 81) {
      try appendObjCProtocol(inout cursor, inout module);
    } else if (tag == 73) {
      try appendObjCInterface(inout cursor, inout module);
    } else if (tag == 74) {
      try appendObjCMethod(inout cursor, inout module);
    } else if (tag == 75) {
      try appendObjCParameter(inout cursor, inout module);
    } else if (tag == 86) {
      try appendObjCAvailability(inout cursor, inout module);
    } else if (tag == 82) {
      try appendObjCProperty(inout cursor, inout module);
    } else if (tag == 87) {
      try appendObjCPropertyAvailability(inout cursor, inout module);
    } else if (tag == 69) {
      try endRecord(inout cursor);
      if (cursor.offset != cursor.batch.byteLength) {
        throw "foreign declaration stream contains records after end";
      }
      try validateCompletedModule(module);
      buildForeignTypeIndices(inout module);
      return module;
    } else {
      throw "foreign declaration stream contains an unknown record";
    }
  }
  throw "foreign declaration stream ended without an end record";
}
