import {
  RawForeignModuleDeclarations,
} from "./foreign-declaration-protocol.zs";
import {
  Token,
  TokenKind,
  tokenize,
} from "./lexer.zs";

// First native .zd slice: inferred scalar function declarations.
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
  returnNullable: boolean;
  line: usize;
  column: usize;
}

export struct RawForeignContractSet {
  moduleSpecifier: String;
  functions: Array<RawForeignFunctionContract>;
}

export struct NativeForeignParameterContract {
  name: String;
  typeName: String;
}

export struct NativeForeignFunctionContract {
  name: String;
  nativeName: String;
  returnType: String;
  parameters: Array<NativeForeignParameterContract>;
}

export struct NativeForeignContractSet {
  moduleSpecifier: String;
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
  const returnNullable = try parseInferredType(inout cursor);
  if (!atText(cursor, ";")) {
    throw contractError(
      cursor,
      "function result facts are not implemented in the first native Z declaration slice"
    );
  }
  cursor.index = cursor.index + 1;
  return RawForeignFunctionContract({
    name,
    parameters,
    returnNullable,
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
  let functions = Array<RawForeignFunctionContract>();
  while (!atText(cursor, "}")) {
    if (!atText(cursor, "export")) {
      throw contractError(
        cursor,
        "the first native Z declaration slice requires an exported function"
      );
    }
    if (
      cursor.index + 1 >= cursor.tokens.length
      || cursor.tokens[cursor.index + 1].text != "function"
    ) {
      throw contractError(
        cursor,
        "native Z declaration types are not implemented yet"
      );
    }
    const declaration = try parseFunction(inout cursor);
    functions.push(declaration);
  }
  try expectText(inout cursor, "}");
  if (cursor.tokens[cursor.index].kind != TokenKind.eof) {
    throw contractError(cursor, "unexpected source after the declared module");
  }
  return RawForeignContractSet({
    moduleSpecifier,
    functions,
  });
}

function scalarTypeName(in nativeType: String): String throws String {
  if (nativeType == "void") return "void";
  if (nativeType == "float") return "f32";
  if (nativeType == "double") return "f64";
  if (nativeType == "signed char") return "i8";
  if (nativeType == "unsigned char") return "u8";
  if (
    nativeType == "short"
    || nativeType == "short int"
    || nativeType == "signed short"
    || nativeType == "signed short int"
  ) return "i16";
  if (
    nativeType == "unsigned short"
    || nativeType == "unsigned short int"
  ) return "u16";
  if (nativeType == "int" || nativeType == "signed int") return "i32";
  if (nativeType == "unsigned" || nativeType == "unsigned int") return "u32";
  if (
    nativeType == "long long"
    || nativeType == "long long int"
    || nativeType == "signed long long"
    || nativeType == "signed long long int"
  ) return "i64";
  if (
    nativeType == "unsigned long long"
    || nativeType == "unsigned long long int"
  ) return "u64";
  if (nativeType == "_Bool" || nativeType == "bool") return "boolean";
  throw `native Z declaration scalar tier does not support "${nativeType}"`;
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

export function normalizeForeignContracts(
  contracts: RawForeignContractSet,
  in declarations: RawForeignModuleDeclarations,
  in expectedModuleSpecifier: String
): NativeForeignContractSet throws String {
  if (contracts.moduleSpecifier != expectedModuleSpecifier) {
    throw `Z declaration module "${contracts.moduleSpecifier}" does not match imported header "${expectedModuleSpecifier}"`;
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
      if (contract.parameters[parameterIndex].capability != "value") {
        throw `native Z declaration scalar parameter "${contract.parameters[parameterIndex].name}" requires value capability`;
      }
      if (contract.parameters[parameterIndex].nullable) {
        throw `native Z declaration scalar parameter "${contract.parameters[parameterIndex].name}" cannot be nullable`;
      }
      match (in declarations.parameters[rawParameterIndex].name) {
        some(nativeName) => {
          if (nativeName != contract.parameters[parameterIndex].name) {
            throw `Z declaration parameter "${contract.parameters[parameterIndex].name}" does not match Clang parameter "${nativeName}"`;
          }
        }
        none => {}
      }
      const typeName = try scalarTypeName(
        declarations.parameters[rawParameterIndex].nativeType
      );
      parameters.push(NativeForeignParameterContract({
        name: contract.parameters[parameterIndex].name.copyBytes(
          0,
          contract.parameters[parameterIndex].name.byteLength
        ),
        typeName,
      }));
      parameterIndex = parameterIndex + 1;
    }
    const returnType = try scalarTypeName(
      declarations.overloads[overloadIndex].returnNativeType
    );
    functions.push(NativeForeignFunctionContract({
      name: contract.name.copyBytes(0, contract.name.byteLength),
      nativeName: declarations.overloads[overloadIndex].nativeName.copyBytes(
        0,
        declarations.overloads[overloadIndex].nativeName.byteLength
      ),
      returnType,
      parameters,
    }));
  }
  return NativeForeignContractSet({
    moduleSpecifier: contracts.moduleSpecifier.copyBytes(
      0,
      contracts.moduleSpecifier.byteLength
    ),
    functions,
  });
}
