import {
  RawForeignModuleDeclarations,
  RawForeignType,
} from "./foreign-declaration-protocol.zs";
import {
  Token,
  TokenKind,
  tokenize,
} from "./lexer.zs";
import { TextBuffer } from "std/text";

// Native .zd slice: inferred scalar/record, value-resource, and integer-status
// functions.
//
// The model is intentionally separate from raw producer declarations. A
// contract must match Clang evidence before it can produce these normalized
// callable shapes.

export struct RawForeignContractParameter {
  name: String;
  capability: String;
  nullable: boolean;
  line: usize;
  column: usize;
}

export struct RawForeignFunctionContract {
  name: String;
  parameters: Array<RawForeignContractParameter>;
  returnKind: String;
  returnNullable: boolean;
  successValues: Array<String>;
  resultOwnership: String;
  line: usize;
  column: usize;
}

export struct RawForeignTypeContract {
  name: String;
  movable: boolean;
  release: String;
  line: usize;
  column: usize;
}

export struct RawForeignContractSet {
  moduleSpecifier: String;
  types: Array<RawForeignTypeContract>;
  functions: Array<RawForeignFunctionContract>;
}

export struct NativeForeignParameterContract {
  name: String;
  capability: String;
  abiMode: String;
  typeName: String;
}

export struct NativeForeignFunctionContract {
  name: String;
  nativeName: String;
  returnType: String;
  errorType: Option<String>;
  successValues: Array<String>;
  parameters: Array<NativeForeignParameterContract>;
}

export struct NativeForeignTypeContract {
  kind: String;
  name: String;
  nativeName: String;
  underlyingType: String;
  layout: String;
  resourceRelease: String;
  fields: Array<NativeForeignFieldContract>;
}

export struct NativeForeignFieldContract {
  name: String;
  typeName: String;
}

export struct NativeForeignConstantContract {
  name: String;
  nativeName: String;
  typeName: String;
}

export struct NativeForeignContractSet {
  moduleSpecifier: String;
  types: Array<NativeForeignTypeContract>;
  constants: Array<NativeForeignConstantContract>;
  functions: Array<NativeForeignFunctionContract>;
}

struct ForeignContractCursor {
  path: String;
  tokens: Array<Token>;
  index: usize;
}

function contractError(
  in cursor: ForeignContractCursor,
  in message: String
): String {
  return `${cursor.path}:${cursor.tokens[cursor.index].line}:${cursor.tokens[cursor.index].column}: error: ${message}`;
}

function contractErrorAt(
  in cursor: ForeignContractCursor,
  line: usize,
  column: usize,
  in message: String
): String {
  return `${cursor.path}:${line}:${column}: error: ${message}`;
}

function atText(in cursor: ForeignContractCursor, in text: String): boolean {
  return cursor.tokens[cursor.index].text == text;
}

function expectText(
  inout cursor: ForeignContractCursor,
  in text: String
): void throws String {
  if (!atText(cursor, text)) {
    throw contractError(
      cursor,
      `expected "${text}" in Z declaration file, found "${cursor.tokens[cursor.index].text}"`
    );
  }
  cursor.index = cursor.index + 1;
}

function expectIdentifier(
  inout cursor: ForeignContractCursor,
  in description: String
): String throws String {
  if (cursor.tokens[cursor.index].kind != TokenKind.identifier) {
    throw contractError(cursor, `expected ${description} in Z declaration file`);
  }
  const value = cursor.tokens[cursor.index].text.copyBytes(
    0,
    cursor.tokens[cursor.index].text.byteLength
  );
  cursor.index = cursor.index + 1;
  return value;
}

function parseQualifiedName(
  inout cursor: ForeignContractCursor
): String throws String {
  let name = try expectIdentifier(
    inout cursor,
    "a native declaration name"
  );
  while (atText(cursor, ".")) {
    cursor.index = cursor.index + 1;
    const member = try expectIdentifier(
      inout cursor,
      "a native declaration name after `.`"
    );
    name = `${name}.${member}`;
  }
  return name;
}

function parseInferredType(
  inout cursor: ForeignContractCursor
): boolean throws String {
  const placeholder = try expectIdentifier(
    inout cursor,
    "`_` as the header-derived type"
  );
  if (placeholder != "_") {
    throw contractError(
      cursor,
      "the first native Z declaration slice requires `_` for a header-derived type"
    );
  }
  if (!atText(cursor, "|")) return false;
  cursor.index = cursor.index + 1;
  try expectText(inout cursor, "null");
  return true;
}

function parseParameter(
  inout cursor: ForeignContractCursor
): RawForeignContractParameter throws String {
  let capability = "value";
  if (atText(cursor, "in")) {
    capability = "in";
    cursor.index = cursor.index + 1;
  } else if (atText(cursor, "inout")) {
    capability = "inout";
    cursor.index = cursor.index + 1;
  } else if (atText(cursor, "out")) {
    capability = "out";
    cursor.index = cursor.index + 1;
  } else if (atText(cursor, "move")) {
    capability = "move";
    cursor.index = cursor.index + 1;
  }
  const line = cursor.tokens[cursor.index].line;
  const column = cursor.tokens[cursor.index].column;
  const name = try expectIdentifier(inout cursor, "a native parameter name");
  try expectText(inout cursor, ":");
  const nullable = try parseInferredType(inout cursor);
  if (atText(cursor, "{")) {
    throw contractError(
      cursor,
      "parameter facts are not implemented in the first native Z declaration slice"
    );
  }
  return RawForeignContractParameter({
    name,
    capability,
    nullable,
    line,
    column,
  });
}

function parseStatusValue(
  inout cursor: ForeignContractCursor
): String throws String {
  let negative = false;
  if (atText(cursor, "-")) {
    negative = true;
    cursor.index = cursor.index + 1;
  }
  if (
    !negative
    && cursor.tokens[cursor.index].kind == TokenKind.identifier
  ) {
    return try parseQualifiedName(inout cursor);
  }
  if (cursor.tokens[cursor.index].kind != TokenKind.number) {
    throw contractError(
      cursor,
      "expected an integer status value or header constant"
    );
  }
  const token = cursor.tokens[cursor.index].text.copyBytes(
    0,
    cursor.tokens[cursor.index].text.byteLength
  );
  let index: usize = 0;
  while (index < token.byteLength) {
    const byte = token.byteAt(index);
    if (byte < 48 || byte > 57) {
      throw contractError(
        cursor,
        "the first native status tier requires a decimal integer"
      );
    }
    index = index + 1;
  }
  cursor.index = cursor.index + 1;
  if (negative) return `-${token}`;
  return token;
}

function isDecimalStatusValue(in value: String): boolean {
  let index: usize = 0;
  if (value.byteLength > 0 && value.byteAt(0) == 45) index = 1;
  if (index >= value.byteLength) return false;
  while (index < value.byteLength) {
    const byte = value.byteAt(index);
    if (byte < 48 || byte > 57) return false;
    index = index + 1;
  }
  return true;
}

function findRawConstant(
  in declarations: RawForeignModuleDeclarations,
  in name: String
): usize throws String {
  let index: usize = 0;
  while (index < declarations.constants.length) {
    if (declarations.constants[index].name == name) return index;
    index = index + 1;
  }
  throw `Z declaration names unknown foreign constant "${name}"`;
}

function parseFunction(
  inout cursor: ForeignContractCursor
): RawForeignFunctionContract throws String {
  try expectText(inout cursor, "export");
  try expectText(inout cursor, "function");
  const line = cursor.tokens[cursor.index].line;
  const column = cursor.tokens[cursor.index].column;
  const name = try parseQualifiedName(inout cursor);
  try expectText(inout cursor, "(");
  let parameters = Array<RawForeignContractParameter>();
  if (!atText(cursor, ")")) {
    while (true) {
      const parameter = try parseParameter(inout cursor);
      parameters.push(parameter);
      if (!atText(cursor, ",")) break;
      cursor.index = cursor.index + 1;
    }
  }
  try expectText(inout cursor, ")");
  try expectText(inout cursor, ":");
  let returnKind = "inferred";
  let returnNullable = false;
  let successValues = Array<String>();
  let resultOwnership = "";
  if (atText(cursor, "void")) {
    returnKind = "status";
    cursor.index = cursor.index + 1;
    try expectText(inout cursor, "throws");
    const errorNullable = try parseInferredType(inout cursor);
    if (errorNullable) {
      throw contractError(cursor, "a native status error cannot be nullable");
    }
    try expectText(inout cursor, "{");
    while (!atText(cursor, "}")) {
      if (!atText(cursor, "success")) {
        throw contractError(
          cursor,
          "only success values are implemented in the first native status tier"
        );
      }
      cursor.index = cursor.index + 1;
      const successValue = try parseStatusValue(inout cursor);
      successValues.push(successValue);
      try expectText(inout cursor, ";");
    }
    try expectText(inout cursor, "}");
    if (successValues.length == 0) {
      throw contractErrorAt(
        cursor,
        line,
        column,
        "a native status contract requires at least one success value"
      );
    }
  } else {
    returnNullable = try parseInferredType(inout cursor);
    if (atText(cursor, "{")) {
      cursor.index = cursor.index + 1;
      while (!atText(cursor, "}")) {
        const fact = try expectIdentifier(
          inout cursor,
          "`owned` or `borrowed` as a native resource result fact"
        );
        if (fact != "owned" && fact != "borrowed") {
          throw contractError(
            cursor,
            `native resource result fact must be "owned" or "borrowed", found "${fact}"`
          );
        }
        if (resultOwnership.byteLength > 0) {
          throw contractError(
            cursor,
            `foreign function "${name}" cannot declare more than one result ownership fact`
          );
        }
        resultOwnership = move fact;
        try expectText(inout cursor, ";");
      }
      try expectText(inout cursor, "}");
      if (resultOwnership.byteLength == 0) {
        throw contractErrorAt(
          cursor,
          line,
          column,
          "a native resource result block requires `owned;` or `borrowed;`"
        );
      }
    } else {
      try expectText(inout cursor, ";");
    }
  }
  return RawForeignFunctionContract({
    name,
    parameters,
    returnKind,
    returnNullable,
    successValues,
    resultOwnership,
    line,
    column,
  });
}

function parseType(
  inout cursor: ForeignContractCursor
): RawForeignTypeContract throws String {
  try expectText(inout cursor, "export");
  try expectText(inout cursor, "type");
  const line = cursor.tokens[cursor.index].line;
  const column = cursor.tokens[cursor.index].column;
  const name = try parseQualifiedName(inout cursor);
  try expectText(inout cursor, "{");
  let movable = false;
  let release = "";
  while (!atText(cursor, "}")) {
    const fact = cursor.tokens[cursor.index].text.copyBytes(
      0,
      cursor.tokens[cursor.index].text.byteLength
    );
    cursor.index = cursor.index + 1;
    if (fact == "move") {
      if (movable) {
        throw contractError(
          cursor,
          `foreign type "${name}" cannot declare move more than once`
        );
      }
      movable = true;
      try expectText(inout cursor, ";");
      continue;
    }
    if (fact == "deinit") {
      if (release.byteLength > 0) {
        throw contractError(
          cursor,
          `foreign type "${name}" cannot declare deinit more than once`
        );
      }
      release = try parseQualifiedName(inout cursor);
      try expectText(inout cursor, ";");
      continue;
    }
    throw contractError(
      cursor,
      `C value resource "${name}" must use \`move;\` and \`deinit <release function>;\`, found "${fact}"`
    );
  }
  try expectText(inout cursor, "}");
  if (!movable || release.byteLength == 0) {
    throw contractErrorAt(
      cursor,
      line,
      column,
      `C value resource "${name}" must declare \`move;\` and \`deinit <release function>;\``
    );
  }
  return RawForeignTypeContract({
    name,
    movable,
    release,
    line,
    column,
  });
}

export function parseForeignContracts(
  source: String,
  in path: String
): RawForeignContractSet throws String {
  const tokenOutcome = attempt tokenize(source);
  const tokens = match (tokenOutcome) {
    success(tokens) => tokens;
    failure(error) => {
      throw `${path}:${error.line}:${error.column}: error: ${error.message}`;
    }
  };
  let cursor = ForeignContractCursor({
    path: path.copyBytes(0, path.byteLength),
    tokens,
    index: 0,
  });
  try expectText(inout cursor, "declare");
  try expectText(inout cursor, "module");
  if (cursor.tokens[cursor.index].kind != TokenKind.string) {
    throw contractError(cursor, "expected a native module string");
  }
  const moduleSpecifier = cursor.tokens[cursor.index].text.copyBytes(
    0,
    cursor.tokens[cursor.index].text.byteLength
  );
  cursor.index = cursor.index + 1;
  try expectText(inout cursor, "{");
  let types = Array<RawForeignTypeContract>();
  let functions = Array<RawForeignFunctionContract>();
  while (!atText(cursor, "}")) {
    if (!atText(cursor, "export")) {
      throw contractError(
        cursor,
        "the first native Z declaration slice requires an exported function"
      );
    }
    if (cursor.index + 1 >= cursor.tokens.length) {
      throw contractError(
        cursor,
        "expected an exported native declaration"
      );
    }
    if (cursor.tokens[cursor.index + 1].text == "type") {
      const declaration = try parseType(inout cursor);
      types.push(declaration);
    } else if (cursor.tokens[cursor.index + 1].text == "function") {
      const declaration = try parseFunction(inout cursor);
      functions.push(declaration);
    } else {
      throw contractError(
        cursor,
        "the native Z declaration slice requires an exported type or function"
      );
    }
  }
  try expectText(inout cursor, "}");
  if (cursor.tokens[cursor.index].kind != TokenKind.eof) {
    throw contractError(cursor, "unexpected source after the declared module");
  }
  return RawForeignContractSet({
    moduleSpecifier,
    types,
    functions,
  });
}

function scalarTypeName(in nativeType: String): String throws String {
  if (nativeType == "void") return "void";
  if (nativeType == "float" || nativeType == "f32") return "f32";
  if (nativeType == "double" || nativeType == "f64") return "f64";
  if (nativeType == "signed char" || nativeType == "i8") return "i8";
  if (nativeType == "unsigned char" || nativeType == "u8") return "u8";
  if (
    nativeType == "short"
    || nativeType == "short int"
    || nativeType == "signed short"
    || nativeType == "signed short int"
    || nativeType == "i16"
  ) return "i16";
  if (
    nativeType == "unsigned short"
    || nativeType == "unsigned short int"
    || nativeType == "u16"
  ) return "u16";
  if (
    nativeType == "int"
    || nativeType == "signed int"
    || nativeType == "i32"
  ) return "i32";
  if (
    nativeType == "unsigned"
    || nativeType == "unsigned int"
    || nativeType == "u32"
  ) return "u32";
  if (
    nativeType == "long long"
    || nativeType == "long long int"
    || nativeType == "signed long long"
    || nativeType == "signed long long int"
    || nativeType == "i64"
  ) return "i64";
  if (
    nativeType == "unsigned long long"
    || nativeType == "unsigned long long int"
    || nativeType == "u64"
  ) return "u64";
  if (nativeType == "_Bool" || nativeType == "bool") return "boolean";
  throw `native Z declaration scalar tier does not support "${nativeType}"`;
}

function foreignEnumTypeIndex(
  in declarations: RawForeignModuleDeclarations,
  in nativeType: String
): Option<usize> {
  let index: usize = 0;
  while (index < declarations.types.length) {
    if (
      declarations.types[index].kind == "enum"
      && (
        nativeType == declarations.types[index].nativeName
        || nativeType == declarations.types[index].exportName
        || nativeType == declarations.types[index].qualifiedName
      )
    ) return Option<usize>.some(index);
    index = index + 1;
  }
  return Option<usize>.none;
}

function recordValueSpelling(in name: String, tagged: boolean): String {
  if (!tagged) return name.copyBytes(0, name.byteLength);
  let output = TextBuffer();
  output.append("struct ");
  output.append(name);
  return output.finish();
}

function foreignRecordTypeIndex(
  in declarations: RawForeignModuleDeclarations,
  in nativeType: String
): Option<usize> {
  let index: usize = 0;
  while (index < declarations.types.length) {
    if (declarations.types[index].kind != "record") {
      index = index + 1;
      continue;
    }
    const nativeName = view declarations.types[index].nativeName;
    const exportName = view declarations.types[index].exportName;
    const taggedNative = recordValueSpelling(nativeName, true);
    const taggedExport = recordValueSpelling(exportName, true);
    if (
      nativeType == nativeName
      || nativeType == exportName
      || nativeType == declarations.types[index].qualifiedName
      || nativeType == declarations.types[index].typeName
      || nativeType == taggedNative
      || nativeType == taggedExport
    ) return Option<usize>.some(index);
    index = index + 1;
  }
  return Option<usize>.none;
}

struct RawRecordPointer {
  typeIndex: usize;
  mutablePointer: boolean;
}

function recordPointerSpelling(
  in name: String,
  constant: boolean,
  tagged: boolean
): String {
  let output = TextBuffer();
  if (constant) output.append("const ");
  if (tagged) output.append("struct ");
  output.append(name);
  output.append(" *");
  return output.finish();
}

function rawRecordPointer(
  in declarations: RawForeignModuleDeclarations,
  in nativeType: String
): Option<RawRecordPointer> {
  let index: usize = 0;
  while (index < declarations.types.length) {
    if (declarations.types[index].kind != "record") {
      index = index + 1;
      continue;
    }
    const nativeName = view declarations.types[index].nativeName;
    const exportName = view declarations.types[index].exportName;
    const mutableNative = recordPointerSpelling(nativeName, false, false);
    const mutableExport = recordPointerSpelling(exportName, false, false);
    const mutableTagged = recordPointerSpelling(nativeName, false, true);
    if (
      nativeType == mutableNative
      || nativeType == mutableExport
      || nativeType == mutableTagged
    ) return Option.some(RawRecordPointer({
      typeIndex: index,
      mutablePointer: true,
    }));
    const constNative = recordPointerSpelling(nativeName, true, false);
    const constExport = recordPointerSpelling(exportName, true, false);
    const constTagged = recordPointerSpelling(nativeName, true, true);
    if (
      nativeType == constNative
      || nativeType == constExport
      || nativeType == constTagged
    ) return Option.some(RawRecordPointer({
      typeIndex: index,
      mutablePointer: false,
    }));
    index = index + 1;
  }
  return Option<RawRecordPointer>.none;
}

function normalizedForeignTypeIndex(
  in types: Array<NativeForeignTypeContract>,
  in name: String
): Option<usize> {
  let index: usize = 0;
  while (index < types.length) {
    if (types[index].name == name) return Option<usize>.some(index);
    index = index + 1;
  }
  return Option<usize>.none;
}

function scalarTypeNameWithCanonical(
  in declarations: RawForeignModuleDeclarations,
  in nativeType: String,
  in canonicalNativeType: Option<String>
): String throws String {
  const direct = attempt scalarTypeName(nativeType);
  match (direct) {
    success(typeName) => return typeName;
    failure(_) => {}
  }
  for (const declaration of declarations.types) {
    if (
      declaration.kind == "scalar"
      && (
        nativeType == declaration.nativeName
        || nativeType == declaration.exportName
        || nativeType == declaration.qualifiedName
        || nativeType == declaration.typeName
      )
    ) return try scalarTypeName(declaration.underlyingType);
  }
  match (in canonicalNativeType) {
    some(typeName) => return try scalarTypeName(typeName);
    none => return try scalarTypeName(nativeType);
  }
}

function foreignValueTypeName(
  in declarations: RawForeignModuleDeclarations,
  in types: Array<NativeForeignTypeContract>,
  in nativeType: String,
  in canonicalNativeType: Option<String>
): String throws String {
  match (foreignEnumTypeIndex(declarations, nativeType)) {
    some(typeIndex) => return declarations.types[
      typeIndex
    ].exportName.copyBytes(
      0,
      declarations.types[typeIndex].exportName.byteLength
    );
    none => {}
  }
  let recordTypeIndex = declarations.types.length;
  match (foreignRecordTypeIndex(declarations, nativeType)) {
    some(typeIndex) => recordTypeIndex = typeIndex;
    none => match (in canonicalNativeType) {
      some(typeName) => match (foreignRecordTypeIndex(
        declarations,
        typeName
      )) {
        some(typeIndex) => recordTypeIndex = typeIndex;
        none => {}
      }
      none => {}
    }
  }
  if (recordTypeIndex < declarations.types.length) {
    const typeName = declarations.types[
      recordTypeIndex
    ].exportName.copyBytes(
      0,
      declarations.types[recordTypeIndex].exportName.byteLength
    );
    match (normalizedForeignTypeIndex(types, typeName)) {
      some(typeIndex) => {
        if (types[typeIndex].kind != "record") {
          throw "native Z declaration record value resolved to a non-record type";
        }
        return typeName;
      }
      none => throw `native Z declaration record value ${typeName} requires a scalar-field struct layout`;
    }
  }
  return try scalarTypeNameWithCanonical(
    declarations,
    nativeType,
    canonicalNativeType
  );
}

function statusScalarTypeName(
  in declarations: RawForeignModuleDeclarations,
  in nativeType: String
): String throws String {
  match (foreignEnumTypeIndex(declarations, nativeType)) {
    some(index) => {
      if (!isIntegerTypeName(declarations.types[index].underlyingType)) {
        throw "native status enum has an unsupported underlying type";
      }
      return declarations.types[index].underlyingType.copyBytes(
        0,
        declarations.types[index].underlyingType.byteLength
      );
    }
    none => return try scalarTypeName(nativeType);
  }
}

function isIntegerTypeName(in typeName: String): boolean {
  return typeName == "i8"
    || typeName == "u8"
    || typeName == "i16"
    || typeName == "u16"
    || typeName == "i32"
    || typeName == "u32"
    || typeName == "i64"
    || typeName == "u64";
}

function normalizedForeignType(
  in declaration: RawForeignType,
  in resourceRelease: String,
  fields: Array<NativeForeignFieldContract>
): NativeForeignTypeContract {
  return NativeForeignTypeContract({
    kind: declaration.kind.copyBytes(0, declaration.kind.byteLength),
    name: declaration.exportName.copyBytes(
      0,
      declaration.exportName.byteLength
    ),
    nativeName: declaration.nativeName.copyBytes(
      0,
      declaration.nativeName.byteLength
    ),
    underlyingType: declaration.underlyingType.copyBytes(
      0,
      declaration.underlyingType.byteLength
    ),
    layout: declaration.layout.copyBytes(
      0,
      declaration.layout.byteLength
    ),
    resourceRelease: resourceRelease.copyBytes(
      0,
      resourceRelease.byteLength
    ),
    fields,
  });
}

function rawForeignCanonicalRecordName(in declaration: RawForeignType): String {
  match (in declaration.canonicalNativeName) {
    some(name) => return name.copyBytes(0, name.byteLength);
    none => return declaration.nativeName.copyBytes(
      0,
      declaration.nativeName.byteLength
    );
  }
}

function resourceContractIndex(
  in contracts: RawForeignContractSet,
  in declaration: RawForeignType
): Option<usize> throws String {
  if (declaration.kind != "record") return Option<usize>.none;
  const canonicalName = rawForeignCanonicalRecordName(declaration);
  let found = contracts.types.length;
  let index: usize = 0;
  while (index < contracts.types.length) {
    const name = view contracts.types[index].name;
    if (
      name == declaration.exportName
      || name == declaration.qualifiedName
      || name == declaration.nativeName
      || name == canonicalName
    ) {
      if (found < contracts.types.length && found != index) {
        throw `foreign aliases for canonical C record "${canonicalName}" declare conflicting resource facts`;
      }
      found = index;
    }
    index = index + 1;
  }
  if (found < contracts.types.length) return Option.some(found);
  return Option<usize>.none;
}

function resourceReleaseForType(
  in contracts: RawForeignContractSet,
  in declaration: RawForeignType
): String throws String {
  const contractIndex = try resourceContractIndex(contracts, declaration);
  match (contractIndex) {
    some(index) => return contracts.types[index].release.copyBytes(
      0,
      contracts.types[index].release.byteLength
    );
    none => return "";
  }
}

function appendRepresentableForeignField(
  in declarations: RawForeignModuleDeclarations,
  in types: Array<NativeForeignTypeContract>,
  in rawFieldName: String,
  in rawFieldType: String,
  inout fields: Array<NativeForeignFieldContract>
): boolean {
  const fieldType = attempt scalarTypeName(rawFieldType);
  match (fieldType) {
    success(typeName) => {
      fields.push(NativeForeignFieldContract({
        name: rawFieldName.copyBytes(0, rawFieldName.byteLength),
        typeName,
      }));
      return true;
    }
    failure(_) => {}
  }
  let nestedTypeIndex = declarations.types.length;
  match (foreignRecordTypeIndex(declarations, rawFieldType)) {
    some(typeIndex) => nestedTypeIndex = typeIndex;
    none => {}
  }
  if (nestedTypeIndex >= declarations.types.length) return false;
  const nestedName = view declarations.types[nestedTypeIndex].exportName;
  match (normalizedForeignTypeIndex(types, nestedName)) {
    some(typeIndex) => {
      if (types[typeIndex].kind != "record") return false;
      fields.push(NativeForeignFieldContract({
        name: rawFieldName.copyBytes(0, rawFieldName.byteLength),
        typeName: nestedName.copyBytes(0, nestedName.byteLength),
      }));
      return true;
    }
    none => return false;
  }
}

function findRawFunction(
  in declarations: RawForeignModuleDeclarations,
  in name: String
): usize throws String {
  let index: usize = 0;
  while (index < declarations.functions.length) {
    if (declarations.functions[index].qualifiedName == name) return index;
    index = index + 1;
  }
  throw `Z declaration names unknown foreign function "${name}"`;
}

function validateResourceContracts(
  in contracts: RawForeignContractSet,
  in declarations: RawForeignModuleDeclarations,
  in types: Array<NativeForeignTypeContract>
): void throws String {
  let contractIndex: usize = 0;
  while (contractIndex < contracts.types.length) {
    let declarationIndex = declarations.types.length;
    let index: usize = 0;
    while (index < declarations.types.length) {
      const matchingContract = try resourceContractIndex(
        contracts,
        declarations.types[index]
      );
      match (matchingContract) {
        some(found) => {
          if (found == contractIndex) {
            declarationIndex = index;
            break;
          }
        }
        none => {}
      }
      index = index + 1;
    }
    if (declarationIndex >= declarations.types.length) {
      throw `declaration names unknown foreign value type "${contracts.types[contractIndex].name}"`;
    }
    const declaration = view declarations.types[declarationIndex];
    if (declaration.layout != "struct") {
      throw `native value-resource contract "${contracts.types[contractIndex].name}" requires a C struct`;
    }
    let normalized = false;
    for (const type of types) {
      if (
        type.resourceRelease == contracts.types[contractIndex].release
        && rawForeignCanonicalRecordName(declaration)
          == rawForeignCanonicalRecordNameByNativeName(
            declarations,
            type.nativeName
          )
      ) normalized = true;
    }
    if (!normalized) {
      throw `native value-resource contract "${contracts.types[contractIndex].name}" could not preserve its C struct layout`;
    }
    const releaseIndex = try findRawFunction(
      declarations,
      contracts.types[contractIndex].release
    );
    if (declarations.functions[releaseIndex].overloadCount != 1) {
      throw `native value-resource deinit "${contracts.types[contractIndex].release}" requires exactly one C overload`;
    }
    const overload = view declarations.overloads[
      declarations.functions[releaseIndex].overloadStart
    ];
    if (overload.parameterCount != 1 || overload.returnNativeType != "void") {
      throw `native value-resource deinit "${contracts.types[contractIndex].release}" must take one record value and return void`;
    }
    const parameter = view declarations.parameters[overload.parameterStart];
    let parameterRecord = declarations.types.length;
    match (foreignRecordTypeIndex(declarations, parameter.nativeType)) {
      some(typeIndex) => parameterRecord = typeIndex;
      none => match (in parameter.canonicalNativeType) {
        some(canonical) => match (foreignRecordTypeIndex(
          declarations,
          canonical
        )) {
          some(typeIndex) => parameterRecord = typeIndex;
          none => {}
        }
        none => {}
      }
    }
    if (
      parameterRecord >= declarations.types.length
      || rawForeignCanonicalRecordName(declarations.types[parameterRecord])
        != rawForeignCanonicalRecordName(declaration)
    ) {
      throw `native value-resource deinit "${contracts.types[contractIndex].release}" consumes a different C record`;
    }
    contractIndex = contractIndex + 1;
  }
}

function rawForeignCanonicalRecordNameByNativeName(
  in declarations: RawForeignModuleDeclarations,
  in nativeName: String
): String {
  for (const declaration of declarations.types) {
    if (declaration.nativeName == nativeName) {
      return rawForeignCanonicalRecordName(declaration);
    }
  }
  return nativeName.copyBytes(0, nativeName.byteLength);
}

export function normalizeForeignContracts(
  contracts: RawForeignContractSet,
  in declarations: RawForeignModuleDeclarations,
  in expectedModuleSpecifier: String
): NativeForeignContractSet throws String {
  if (contracts.moduleSpecifier != expectedModuleSpecifier) {
    throw `Z declaration module "${contracts.moduleSpecifier}" does not match imported header "${expectedModuleSpecifier}"`;
  }
  let types = Array<NativeForeignTypeContract>();
  for (const declaration of declarations.types) {
    if (declaration.kind != "enum") continue;
    types.push(normalizedForeignType(
      declaration,
      "",
      Array<NativeForeignFieldContract>()
    ));
  }
  let recordAdded = true;
  while (recordAdded) {
    recordAdded = false;
    for (const declaration of declarations.types) {
      if (
        declaration.kind != "record"
        || declaration.layout != "struct"
      ) continue;
      match (normalizedForeignTypeIndex(types, declaration.exportName)) {
        some(_) => continue;
        none => {}
      }
      const resourceRelease = try resourceReleaseForType(
        contracts,
        declaration
      );
      let fields = Array<NativeForeignFieldContract>();
      let compatible = true;
      let fieldIndex: usize = 0;
      while (fieldIndex < declaration.fieldCount) {
        const rawField = view declarations.fields[
          declaration.fieldStart + fieldIndex
        ];
        const represented = appendRepresentableForeignField(
          declarations,
          types,
          rawField.name,
          rawField.typeName,
          inout fields
        );
        if (!represented) {
          if (resourceRelease.byteLength == 0) {
            compatible = false;
            break;
          }
        }
        fieldIndex = fieldIndex + 1;
      }
      if (!compatible) continue;
      types.push(normalizedForeignType(
        declaration,
        resourceRelease,
        fields
      ));
      recordAdded = true;
    }
  }
  try validateResourceContracts(contracts, declarations, types);
  let constants = Array<NativeForeignConstantContract>();
  for (const declaration of declarations.constants) {
    let typeName = "";
    let typeIndex: usize = 0;
    while (typeIndex < declarations.types.length) {
      if (
        declarations.types[typeIndex].kind == "enum"
        && declaration.typeName == declarations.types[typeIndex].typeName
      ) {
        typeName = declarations.types[typeIndex].exportName.copyBytes(
          0,
          declarations.types[typeIndex].exportName.byteLength
        );
        break;
      }
      typeIndex = typeIndex + 1;
    }
    if (typeName.byteLength == 0) {
      const scalar = attempt scalarTypeName(declaration.typeName);
      match (scalar) {
        success(name) => typeName = move name;
        failure(_) => continue;
      }
    }
    constants.push(NativeForeignConstantContract({
      name: declaration.name.copyBytes(0, declaration.name.byteLength),
      nativeName: declaration.nativeName.copyBytes(
        0,
        declaration.nativeName.byteLength
      ),
      typeName,
    }));
  }
  let functions = Array<NativeForeignFunctionContract>();
  for (const contract of contracts.functions) {
    const functionIndex = try findRawFunction(declarations, contract.name);
    if (declarations.functions[functionIndex].overloadCount != 1) {
      throw `native Z declaration scalar tier requires exactly one overload for "${contract.name}"`;
    }
    const overloadIndex = declarations.functions[functionIndex].overloadStart;
    if (
      contract.parameters.length
      != declarations.overloads[overloadIndex].parameterCount
    ) {
      throw `Z declaration for "${contract.name}" has ${contract.parameters.length} parameters but Clang reports ${declarations.overloads[overloadIndex].parameterCount}`;
    }
    if (contract.returnNullable) {
      throw `native Z declaration scalar result "${contract.name}" cannot be nullable`;
    }
    let parameters = Array<NativeForeignParameterContract>();
    let parameterIndex: usize = 0;
    while (parameterIndex < contract.parameters.length) {
      const rawParameterIndex = declarations.overloads[
        overloadIndex
      ].parameterStart + parameterIndex;
      if (contract.parameters[parameterIndex].nullable) {
        throw `native Z declaration parameter "${contract.parameters[parameterIndex].name}" cannot be nullable in this tier`;
      }
      match (in declarations.parameters[rawParameterIndex].name) {
        some(nativeName) => {
          if (nativeName != contract.parameters[parameterIndex].name) {
            throw `Z declaration parameter "${contract.parameters[parameterIndex].name}" does not match Clang parameter "${nativeName}"`;
          }
        }
        none => {}
      }
      const capability = view contract.parameters[parameterIndex].capability;
      let abiMode = capability.copyBytes(0, capability.byteLength);
      let typeName = "";
      if (capability == "value") {
        typeName = try foreignValueTypeName(
          declarations,
          types,
          declarations.parameters[rawParameterIndex].nativeType,
          declarations.parameters[rawParameterIndex].canonicalNativeType
        );
        match (normalizedForeignTypeIndex(types, typeName)) {
          some(typeIndex) => {
            if (types[typeIndex].resourceRelease.byteLength > 0) {
              throw `native value-resource parameter "${contract.parameters[parameterIndex].name}" requires explicit in, inout, out, or move capability`;
            }
          }
          none => {}
        }
      } else {
        let valueTypeIndex = declarations.types.length;
        match (foreignRecordTypeIndex(
          declarations,
          declarations.parameters[rawParameterIndex].nativeType
        )) {
          some(typeIndex) => valueTypeIndex = typeIndex;
          none => match (
            in declarations.parameters[rawParameterIndex].canonicalNativeType
          ) {
            some(canonical) => match (foreignRecordTypeIndex(
              declarations,
              canonical
            )) {
              some(typeIndex) => valueTypeIndex = typeIndex;
              none => {}
            }
            none => {}
          }
        }
        if (valueTypeIndex < declarations.types.length) {
          typeName = declarations.types[valueTypeIndex].exportName.copyBytes(
            0,
            declarations.types[valueTypeIndex].exportName.byteLength
          );
          let resource = false;
          match (normalizedForeignTypeIndex(types, typeName)) {
            some(typeIndex) => {
              resource = types[typeIndex].resourceRelease.byteLength > 0;
            }
            none => {}
          }
          if (!resource || (capability != "in" && capability != "move")) {
            let expectedShape = "value-resource capability";
            if (capability == "inout" || capability == "out") {
              expectedShape = "pointer";
            }
            throw `native Z declaration ${capability} parameter "${contract.parameters[parameterIndex].name}" requires a matching C record ${expectedShape}`;
          }
          if (capability == "in") abiMode = "inValue";
        } else {
          let pointerTypeIndex = declarations.types.length;
          let mutablePointer = false;
          match (rawRecordPointer(
            declarations,
            declarations.parameters[rawParameterIndex].nativeType
          )) {
            some(value) => {
              pointerTypeIndex = value.typeIndex;
              mutablePointer = value.mutablePointer;
            }
            none => throw `native Z declaration ${capability} parameter "${contract.parameters[parameterIndex].name}" requires a C record pointer or classified value resource`;
          }
          if (
            capability != "in"
            && capability != "inout"
            && capability != "out"
          ) {
            throw `native Z declaration parameter "${contract.parameters[parameterIndex].name}" has unsupported capability ${capability}`;
          }
          if (capability != "in" && !mutablePointer) {
            throw `native Z declaration ${capability} parameter "${contract.parameters[parameterIndex].name}" requires a mutable C record pointer`;
          }
          typeName = declarations.types[pointerTypeIndex].exportName.copyBytes(
            0,
            declarations.types[pointerTypeIndex].exportName.byteLength
          );
        }
        match (normalizedForeignTypeIndex(types, typeName)) {
          some(typeIndex) => {
            if (types[typeIndex].kind != "record") {
              throw "native Z declaration record pointer resolved to a non-record type";
            }
          }
          none => throw `native Z declaration record parameter "${contract.parameters[parameterIndex].name}" requires a scalar-field struct layout`;
        }
      }
      parameters.push(NativeForeignParameterContract({
        name: contract.parameters[parameterIndex].name.copyBytes(
          0,
          contract.parameters[parameterIndex].name.byteLength
        ),
        capability: capability.copyBytes(0, capability.byteLength),
        abiMode,
        typeName,
      }));
      parameterIndex = parameterIndex + 1;
    }
    let nativeReturnType = "";
    if (contract.returnKind == "status") {
      nativeReturnType = try statusScalarTypeName(
        declarations,
        declarations.overloads[overloadIndex].returnNativeType
      );
    } else {
      nativeReturnType = try foreignValueTypeName(
        declarations,
        types,
        declarations.overloads[overloadIndex].returnNativeType,
        declarations.overloads[overloadIndex].returnCanonicalNativeType
      );
    }
    let returnType = nativeReturnType.copyBytes(
      0,
      nativeReturnType.byteLength
    );
    let errorType = Option<String>.none;
    let successValues = Array<String>();
    if (contract.returnKind == "status") {
      if (!isIntegerTypeName(nativeReturnType)) {
        throw `native status function "${contract.name}" must return an integer scalar`;
      }
      returnType = "void";
      match (foreignEnumTypeIndex(
        declarations,
        declarations.overloads[overloadIndex].returnNativeType
      )) {
        some(typeIndex) => {
          errorType = Option.some(
            declarations.types[typeIndex].exportName.copyBytes(
              0,
              declarations.types[typeIndex].exportName.byteLength
            )
          );
        }
        none => {
          errorType = Option.some(nativeReturnType.copyBytes(
            0,
            nativeReturnType.byteLength
          ));
        }
      }
      for (const successValue of contract.successValues) {
        if (isDecimalStatusValue(successValue)) {
          successValues.push(
            successValue.copyBytes(0, successValue.byteLength)
          );
        } else {
          const constantIndex = try findRawConstant(
            declarations,
            successValue
          );
          match (foreignEnumTypeIndex(
            declarations,
            declarations.overloads[overloadIndex].returnNativeType
          )) {
            some(typeIndex) => {
              if (
                declarations.constants[constantIndex].typeName
                  != declarations.types[typeIndex].typeName
              ) {
                throw `native success constant "${successValue}" has type ${declarations.constants[constantIndex].typeName}, expected enum ${declarations.types[typeIndex].exportName}`;
              }
            }
            none => {
              if (
                declarations.constants[constantIndex].typeName
                  != nativeReturnType
              ) {
                throw `native success constant "${successValue}" has type ${declarations.constants[constantIndex].typeName}, expected ${nativeReturnType}`;
              }
            }
          }
          successValues.push(
            declarations.constants[constantIndex].nativeName.copyBytes(
              0,
              declarations.constants[constantIndex].nativeName.byteLength
            )
          );
        }
      }
    } else {
      let resourceRelease = "";
      match (normalizedForeignTypeIndex(types, nativeReturnType)) {
        some(typeIndex) => {
          resourceRelease = types[typeIndex].resourceRelease.copyBytes(
            0,
            types[typeIndex].resourceRelease.byteLength
          );
        }
        none => {}
      }
      if (resourceRelease.byteLength > 0) {
        if (contract.resultOwnership.byteLength == 0) {
          throw `native value-resource producer "${contract.name}" must declare owned or borrowed result ownership`;
        }
        if (contract.resultOwnership == "borrowed") {
          returnType = `view ${nativeReturnType}`;
        } else if (contract.resultOwnership != "owned") {
          throw `native value-resource producer "${contract.name}" has unsupported result ownership ${contract.resultOwnership}`;
        }
      } else if (contract.resultOwnership.byteLength > 0) {
        throw `native function "${contract.name}" declares ${contract.resultOwnership} but its result is not a classified C value resource`;
      }
    }
    functions.push(NativeForeignFunctionContract({
      name: contract.name.copyBytes(0, contract.name.byteLength),
      nativeName: declarations.overloads[overloadIndex].nativeName.copyBytes(
        0,
        declarations.overloads[overloadIndex].nativeName.byteLength
      ),
      returnType,
      errorType,
      successValues,
      parameters,
    }));
  }
  return NativeForeignContractSet({
    moduleSpecifier: contracts.moduleSpecifier.copyBytes(
      0,
      contracts.moduleSpecifier.byteLength
    ),
    types,
    constants,
    functions,
  });
}
