// Versioned producer-facing foreign declaration framing.
//
// Text fields are length-prefixed UTF-8 rather than delimiter escaped, so the
// decoder can preserve arbitrary names while walking one bounded stream.

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
  underlyingType: String;
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

export struct RawForeignModuleDeclarations {
  version: usize;
  producer: String;
  framework: Option<String>;
  objectiveC: boolean;
  cPlusPlus: boolean;
  namespaces: Array<String>;
  types: Array<RawForeignType>;
  constants: Array<RawForeignConstant>;
  functions: Array<RawForeignFunction>;
  overloads: Array<RawForeignOverload>;
  parameters: Array<RawForeignParameter>;
  availability: Array<RawForeignAvailability>;
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
    constants: Array<RawForeignConstant>(),
    functions: Array<RawForeignFunction>(),
    overloads: Array<RawForeignOverload>(),
    parameters: Array<RawForeignParameter>(),
    availability: Array<RawForeignAvailability>(),
  });
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
  if (kind != "enum") {
    throw "foreign declaration stream contains an unsupported named type";
  }
  const exportName = try readText(inout cursor);
  const qualifiedName = try readText(inout cursor);
  const typeName = try readText(inout cursor);
  const nativeName = try readText(inout cursor);
  const underlyingType = try readText(inout cursor);
  const sourceFile = try readOptionalText(inout cursor);
  const sourceLine = try readHexUsize(inout cursor);
  const sourceColumn = try readHexUsize(inout cursor);
  const sourceLength = try readHexUsize(inout cursor);
  module.types.push(RawForeignType({
    typeIndex,
    kind,
    exportName,
    qualifiedName,
    typeName,
    nativeName,
    underlyingType,
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

function validateCompletedModule(
  in module: RawForeignModuleDeclarations
): void throws String {
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
  if (module.version != 3) {
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
    } else if (tag == 69) {
      try endRecord(inout cursor);
      if (cursor.offset != cursor.batch.byteLength) {
        throw "foreign declaration stream contains records after end";
      }
      try validateCompletedModule(module);
      return module;
    } else {
      throw "foreign declaration stream contains an unknown record";
    }
  }
  throw "foreign declaration stream ended without an end record";
}
