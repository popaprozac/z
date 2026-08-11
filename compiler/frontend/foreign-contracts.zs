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

// Native .zd slice: inferred scalar/record, value-resource, opaque-handle, and
// integer-status functions.
//
// The model is intentionally separate from raw producer declarations. A
// contract must match Clang evidence before it can produce these normalized
// callable shapes.

export struct RawForeignContractParameter {
  name: String;
  capability: String;
  nullable: boolean;
  nullOnly: boolean;
  fixedValue: String;
  release: String;
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
  resultBorrowedFrom: String;
  invalidates: Array<String>;
  resultRelease: String;
  line: usize;
  column: usize;
}

export struct RawForeignTypeContract {
  name: String;
  movable: boolean;
  release: String;
  discriminantMember: String;
  variants: Array<RawForeignUnionVariant>;
  fallback: String;
  fieldProjections: Array<RawForeignFieldProjection>;
  line: usize;
  column: usize;
}

export struct RawForeignFieldProjection {
  name: String;
  typeName: String;
  lifetime: String;
}

export struct RawForeignUnionVariant {
  name: String;
  member: String;
  values: Array<String>;
}

export struct RawForeignContractSet {
  moduleSpecifier: String;
  lifetimes: Array<String>;
  types: Array<RawForeignTypeContract>;
  functions: Array<RawForeignFunctionContract>;
}

export struct NativeForeignParameterContract {
  name: String;
  capability: String;
  abiMode: String;
  typeName: String;
  nullOnly: boolean;
  fixedValue: String;
}

export struct NativeForeignFunctionContract {
  name: String;
  nativeName: String;
  returnType: String;
  errorType: Option<String>;
  successValues: Array<String>;
  parameters: Array<NativeForeignParameterContract>;
  borrowedFromParameter: Option<usize>;
  invalidatesParameters: Array<usize>;
  invalidatesLifetimes: Array<String>;
}

export struct NativeForeignTypeContract {
  kind: String;
  name: String;
  nativeName: String;
  underlyingType: String;
  layout: String;
  resourceRelease: String;
  fields: Array<NativeForeignFieldContract>;
  viewOnly: boolean;
  discriminantMember: String;
  variants: Array<NativeForeignUnionVariant>;
  fallback: String;
}

export struct NativeForeignUnionVariant {
  name: String;
  member: String;
  payloadType: String;
  values: Array<String>;
}

export struct NativeForeignFieldContract {
  name: String;
  typeName: String;
  lifetime: String;
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

function parseReturnType(
  inout cursor: ForeignContractCursor,
  inout returnKind: String
): boolean throws String {
  if (!atText(cursor, "view")) {
    return try parseInferredType(inout cursor);
  }
  cursor.index = cursor.index + 1;
  const target = try expectIdentifier(
    inout cursor,
    "`cstring` after `view`"
  );
  if (target != "cstring") {
    throw contractError(
      cursor,
      "foreign borrowed text results currently require `view cstring`"
    );
  }
  returnKind = "view-cstring";
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
  let nullOnly = false;
  let nullable = false;
  if (atText(cursor, "null")) {
    nullOnly = true;
    nullable = true;
    cursor.index = cursor.index + 1;
  } else {
    nullable = try parseInferredType(inout cursor);
  }
  let fixedValue = "";
  let release = "";
  if (atText(cursor, "{")) {
    cursor.index = cursor.index + 1;
    while (!atText(cursor, "}")) {
      const fact = cursor.tokens[cursor.index].text.copyBytes(
        0,
        cursor.tokens[cursor.index].text.byteLength
      );
      cursor.index = cursor.index + 1;
      if (fact == "fixed") {
        if (fixedValue.byteLength > 0) {
          throw contractError(
            cursor,
            `foreign parameter "${name}" cannot declare fixed more than once`
          );
        }
        fixedValue = try expectIdentifier(
          inout cursor,
          "a native constant after `fixed`"
        );
        try expectText(inout cursor, ";");
        continue;
      }
      if (fact != "deinit") {
        throw contractError(
          cursor,
          `native parameter fact must be "fixed" or "deinit", found "${fact}"`
        );
      }
      if (release.byteLength > 0) {
        throw contractError(
          cursor,
          `foreign parameter "${name}" cannot declare deinit more than once`
        );
      }
      release = try parseQualifiedName(inout cursor);
      try expectText(inout cursor, ";");
    }
    try expectText(inout cursor, "}");
  }
  if (nullOnly && capability != "value") {
    throw contractErrorAt(
      cursor,
      line,
      column,
      `null-only foreign parameter "${name}" cannot declare a capability`
    );
  }
  if (nullOnly && release.byteLength > 0) {
    throw contractErrorAt(
      cursor,
      line,
      column,
      `null-only foreign parameter "${name}" cannot declare deinit`
    );
  }
  if (fixedValue.byteLength > 0) {
    if (capability != "value" || nullOnly || nullable) {
      throw contractErrorAt(
        cursor,
        line,
        column,
        `fixed foreign parameter "${name}" cannot declare a capability or nullable type`
      );
    }
    if (release.byteLength > 0) {
      throw contractErrorAt(
        cursor,
        line,
        column,
        `fixed foreign parameter "${name}" cannot declare deinit`
      );
    }
  }
  return RawForeignContractParameter({
    name,
    capability,
    nullable,
    nullOnly,
    fixedValue,
    release,
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
  inout cursor: ForeignContractCursor,
  in lifetimes: Array<String>
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
  let resultBorrowedFrom = "";
  let invalidates = Array<String>();
  let resultRelease = "";
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
      if (atText(cursor, "invalidates")) {
        cursor.index = cursor.index + 1;
        const owner = try parseQualifiedName(inout cursor);
        for (const existing of invalidates) {
          if (existing == owner) {
            throw contractError(cursor, `foreign function "${name}" cannot invalidate parameter "${owner}" more than once`);
          }
        }
        invalidates.push(owner);
        try expectText(inout cursor, ";");
        continue;
      }
      if (!atText(cursor, "success")) {
        throw contractError(
          cursor,
          "only success and invalidates facts are implemented in the first native status tier"
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
    returnNullable = try parseReturnType(inout cursor, inout returnKind);
    if (atText(cursor, "{")) {
      cursor.index = cursor.index + 1;
      while (!atText(cursor, "}")) {
        const fact = cursor.tokens[cursor.index].text.copyBytes(
          0,
          cursor.tokens[cursor.index].text.byteLength
        );
        cursor.index = cursor.index + 1;
        if (fact == "deinit") {
          if (resultRelease.byteLength > 0) {
            throw contractError(
              cursor,
              `foreign function "${name}" cannot declare deinit more than once`
            );
          }
          resultRelease = try parseQualifiedName(inout cursor);
          try expectText(inout cursor, ";");
          continue;
        }
        if (fact == "invalidates") {
          const owner = try parseQualifiedName(inout cursor);
          for (const existing of invalidates) {
            if (existing == owner) {
              throw contractError(cursor, `foreign function "${name}" cannot invalidate parameter "${owner}" more than once`);
            }
          }
          invalidates.push(owner);
          try expectText(inout cursor, ";");
          continue;
        }
        if (fact != "owned" && fact != "borrowed") {
          throw contractError(
            cursor,
            `native result fact must be "owned", "borrowed", "invalidates", or "deinit", found "${fact}"`
          );
        }
        if (resultOwnership.byteLength > 0) {
          throw contractError(
            cursor,
            `foreign function "${name}" cannot declare more than one result ownership fact`
          );
        }
        resultOwnership = move fact;
        if (resultOwnership == "borrowed" && atText(cursor, "from")) {
          cursor.index = cursor.index + 1;
          resultBorrowedFrom = try parseQualifiedName(inout cursor);
        }
        try expectText(inout cursor, ";");
      }
      try expectText(inout cursor, "}");
      if (
        resultOwnership.byteLength == 0
        && resultRelease.byteLength == 0
        && invalidates.length == 0
      ) {
        throw contractErrorAt(
          cursor,
          line,
          column,
          "a native resource result block requires `owned;`, `borrowed;`, or `deinit <release>;`"
        );
      }
      if (
        resultOwnership.byteLength > 0
        && resultRelease.byteLength > 0
      ) {
        throw contractErrorAt(
          cursor,
          line,
          column,
          `foreign function "${name}" cannot combine value-resource ownership with pointer deinit ownership`
        );
      }
    } else {
      try expectText(inout cursor, ";");
    }
  }
  if (resultBorrowedFrom.byteLength > 0) {
    let ownerIndex = parameters.length;
    let parameterIndex: usize = 0;
    while (parameterIndex < parameters.length) {
      if (parameters[parameterIndex].name == resultBorrowedFrom) {
        ownerIndex = parameterIndex;
        break;
      }
      parameterIndex = parameterIndex + 1;
    }
    if (ownerIndex == parameters.length) {
      throw contractErrorAt(
        cursor,
        line,
        column,
        `borrowed result from "${name}" names unknown owner parameter "${resultBorrowedFrom}"`
      );
    }
    if (parameters[ownerIndex].capability != "in") {
      throw contractErrorAt(
        cursor,
        parameters[ownerIndex].line,
        parameters[ownerIndex].column,
        `borrowed result owner "${resultBorrowedFrom}" must be an immutable in parameter`
      );
    }
    if (parameters[ownerIndex].nullable) {
      throw contractErrorAt(
        cursor,
        parameters[ownerIndex].line,
        parameters[ownerIndex].column,
        `borrowed result owner "${resultBorrowedFrom}" must be non-null`
      );
    }
  }
  for (const invalidatedOwner of invalidates) {
    let ownerIndex = parameters.length;
    let parameterIndex: usize = 0;
    while (parameterIndex < parameters.length) {
      if (parameters[parameterIndex].name == invalidatedOwner) {
        ownerIndex = parameterIndex;
        break;
      }
      parameterIndex = parameterIndex + 1;
    }
    if (ownerIndex == parameters.length) {
      let knownLifetime = false;
      for (const lifetime of lifetimes) {
        if (lifetime == invalidatedOwner) {
          knownLifetime = true;
          break;
        }
      }
      if (!knownLifetime) {
        throw contractErrorAt(
          cursor,
          line,
          column,
          `invalidation on "${name}" names unknown owner parameter or foreign lifetime "${invalidatedOwner}"`
        );
      }
      continue;
    }
    if (parameters[ownerIndex].capability != "in") {
      throw contractErrorAt(
        cursor,
        parameters[ownerIndex].line,
        parameters[ownerIndex].column,
        `invalidated owner "${invalidatedOwner}" must be an immutable in parameter`
      );
    }
    if (parameters[ownerIndex].nullable) {
      throw contractErrorAt(
        cursor,
        parameters[ownerIndex].line,
        parameters[ownerIndex].column,
        `invalidated owner "${invalidatedOwner}" must be non-null`
      );
    }
  }
  return RawForeignFunctionContract({
    name,
    parameters,
    returnKind,
    returnNullable,
    successValues,
    resultOwnership,
    resultBorrowedFrom,
    invalidates,
    resultRelease,
    line,
    column,
  });
}

function foreignUnionVariantNameExists(
  in variants: Array<RawForeignUnionVariant>,
  in name: String
): boolean {
  for (const variant of variants) {
    if (variant.name == name) return true;
  }
  return false;
}

function foreignUnionValueExists(
  in variants: Array<RawForeignUnionVariant>,
  in value: String
): boolean {
  for (const variant of variants) {
    for (const known of variant.values) {
      if (known == value) return true;
    }
  }
  return false;
}

function foreignStringArrayContains(
  in values: Array<String>,
  in value: String
): boolean {
  for (const known of values) {
    if (known == value) return true;
  }
  return false;
}

function parseUnionDiscriminant(
  inout cursor: ForeignContractCursor,
  in typeName: String,
  inout discriminantMember: String,
  inout variants: Array<RawForeignUnionVariant>,
  inout fallback: String
): void throws String {
  try expectText(inout cursor, "discriminant");
  discriminantMember = try expectIdentifier(
    inout cursor,
    "a native union discriminator member"
  );
  try expectText(inout cursor, "{");
  while (!atText(cursor, "}")) {
    if (atText(cursor, "fallback")) {
      cursor.index = cursor.index + 1;
      if (fallback.byteLength > 0) {
        throw contractError(
          cursor,
          `foreign discriminated union "${typeName}" cannot declare more than one fallback`
        );
      }
      fallback = try expectIdentifier(
        inout cursor,
        "a Z-visible fallback variant name"
      );
      if (foreignUnionVariantNameExists(variants, fallback)) {
        throw contractError(
          cursor,
          `duplicate discriminated-union variant "${fallback}"`
        );
      }
      try expectText(inout cursor, ";");
      continue;
    }
    try expectText(inout cursor, "variant");
    const name = try expectIdentifier(
      inout cursor,
      "a Z-visible discriminated-union variant name"
    );
    if (
      name == fallback
      || foreignUnionVariantNameExists(variants, name)
    ) {
      throw contractError(
        cursor,
        `duplicate discriminated-union variant "${name}"`
      );
    }
    try expectText(inout cursor, "{");
    let member = "";
    let values = Array<String>();
    while (!atText(cursor, "}")) {
      if (atText(cursor, "member")) {
        cursor.index = cursor.index + 1;
        if (member.byteLength > 0) {
          throw contractError(
            cursor,
            `discriminated-union variant "${name}" cannot declare more than one native member`
          );
        }
        member = try expectIdentifier(
          inout cursor,
          "a native union member after `member`"
        );
        try expectText(inout cursor, ";");
        continue;
      }
      if (atText(cursor, "when")) {
        cursor.index = cursor.index + 1;
        const value = try expectIdentifier(
          inout cursor,
          "a header constant after `when`"
        );
        if (
          foreignUnionValueExists(variants, value)
          || foreignStringArrayContains(values, value)
        ) {
          throw contractError(
            cursor,
            `native discriminator value "${value}" is already assigned to another variant`
          );
        }
        values.push(value);
        try expectText(inout cursor, ";");
        continue;
      }
      throw contractError(
        cursor,
        `expected "member" or "when" in discriminated-union variant "${name}"`
      );
    }
    try expectText(inout cursor, "}");
    if (values.length == 0) {
      throw contractError(
        cursor,
        `discriminated-union variant "${name}" requires at least one when fact`
      );
    }
    variants.push(RawForeignUnionVariant({ name, member, values }));
  }
  try expectText(inout cursor, "}");
  if (variants.length == 0 || fallback.byteLength == 0) {
    throw contractError(
      cursor,
      `foreign discriminated union "${typeName}" requires variants and one fallback`
    );
  }
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
  let discriminantMember = "";
  let variants = Array<RawForeignUnionVariant>();
  let fallback = "";
  let fieldProjections = Array<RawForeignFieldProjection>();
  while (!atText(cursor, "}")) {
    if (atText(cursor, "project")) {
      cursor.index = cursor.index + 1;
      const projectionName = try expectIdentifier(
        inout cursor,
        "a Z-visible projected field name"
      );
      for (const projection of fieldProjections) {
        if (projection.name == projectionName) {
          throw contractError(
            cursor,
            `foreign type "${name}" cannot project field "${projectionName}" more than once`
          );
        }
      }
      try expectText(inout cursor, ":");
      try expectText(inout cursor, "view");
      try expectText(inout cursor, "cstring");
      let typeName = "view cstring";
      if (atText(cursor, "|")) {
        cursor.index = cursor.index + 1;
        try expectText(inout cursor, "null");
        typeName = "view cstring | null";
      }
      try expectText(inout cursor, "{");
      try expectText(inout cursor, "borrowed");
      try expectText(inout cursor, "from");
      const lifetime = try expectIdentifier(
        inout cursor,
        "a foreign lifetime after borrowed from"
      );
      try expectText(inout cursor, ";");
      try expectText(inout cursor, "}");
      fieldProjections.push(RawForeignFieldProjection({
        name: projectionName,
        typeName,
        lifetime,
      }));
      continue;
    }
    if (atText(cursor, "discriminant")) {
      if (discriminantMember.byteLength > 0) {
        throw contractError(
          cursor,
          `foreign type "${name}" cannot declare more than one discriminant contract`
        );
      }
      try parseUnionDiscriminant(
        inout cursor,
        name,
        inout discriminantMember,
        inout variants,
        inout fallback
      );
      continue;
    }
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
  if (
    discriminantMember.byteLength > 0
    && (movable || release.byteLength > 0)
  ) {
    throw contractErrorAt(
      cursor,
      line,
      column,
      `foreign discriminated union "${name}" cannot also declare value lifecycle facts in the first tier`
    );
  }
  if (
    discriminantMember.byteLength == 0
    && fieldProjections.length == 0
    && (!movable || release.byteLength == 0)
  ) {
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
    discriminantMember,
    variants,
    fallback,
    fieldProjections,
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
  let lifetimes = Array<String>();
  let types = Array<RawForeignTypeContract>();
  let functions = Array<RawForeignFunctionContract>();
  while (!atText(cursor, "}")) {
    if (atText(cursor, "lifetime")) {
      cursor.index = cursor.index + 1;
      const lifetime = try expectIdentifier(
        inout cursor,
        "a foreign lifetime identity"
      );
      for (const existing of lifetimes) {
        if (existing == lifetime) {
          throw contractError(cursor, `duplicate foreign lifetime "${lifetime}"`);
        }
      }
      lifetimes.push(lifetime);
      try expectText(inout cursor, ";");
      continue;
    }
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
      const declaration = try parseFunction(inout cursor, lifetimes);
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
    lifetimes,
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

function isCharacterPointer(in nativeType: String): boolean {
  return nativeType == "char *"
    || nativeType == "const char *"
    || nativeType == "signed char *"
    || nativeType == "const signed char *"
    || nativeType == "unsigned char *"
    || nativeType == "const unsigned char *";
}

function isCharacterPointerReturn(
  in nativeType: String,
  in canonicalNativeType: Option<String>
): boolean {
  if (isCharacterPointer(nativeType)) return true;
  return match (in canonicalNativeType) {
    some(typeName) => isCharacterPointer(typeName);
    none => false;
  };
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
        if (types[typeIndex].viewOnly) {
          throw `native Z declaration record value ${typeName} contains hidden pointer fields and is view-only`;
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
  fields: Array<NativeForeignFieldContract>,
  viewOnly: boolean
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
    viewOnly,
    discriminantMember: "",
    variants: Array<NativeForeignUnionVariant>(),
    fallback: "",
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
    if (
      contracts.types[index].discriminantMember.byteLength > 0
      || contracts.types[index].release.byteLength == 0
    ) {
      index = index + 1;
      continue;
    }
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
  match (foreignEnumTypeIndex(declarations, rawFieldType)) {
    some(typeIndex) => {
      fields.push(NativeForeignFieldContract({
        name: rawFieldName.copyBytes(0, rawFieldName.byteLength),
        typeName: declarations.types[typeIndex].exportName.copyBytes(
          0,
          declarations.types[typeIndex].exportName.byteLength
        ),
        lifetime: "",
      }));
      return true;
    }
    none => {}
  }
  const fieldType = attempt scalarTypeNameWithCanonical(
    declarations,
    rawFieldType,
    Option<String>.none
  );
  match (fieldType) {
    success(typeName) => {
      fields.push(NativeForeignFieldContract({
        name: rawFieldName.copyBytes(0, rawFieldName.byteLength),
        typeName,
        lifetime: "",
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
        lifetime: "",
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
    if (
      contracts.types[contractIndex].discriminantMember.byteLength > 0
      || contracts.types[contractIndex].release.byteLength == 0
    ) {
      contractIndex = contractIndex + 1;
      continue;
    }
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

function pointerStarCount(in nativeType: String): usize {
  let count: usize = 0;
  let index: usize = 0;
  while (index < nativeType.byteLength) {
    if (nativeType.byteAt(index) == 42) count = count + 1;
    index = index + 1;
  }
  return count;
}

function removeTrailingPointer(in nativeType: String): String throws String {
  let end = nativeType.byteLength;
  while (end > 0 && nativeType.byteAt(end - 1) == 32) {
    end = end - 1;
  }
  if (end == 0 || nativeType.byteAt(end - 1) != 42) {
    throw `native handle type ${nativeType} is not a pointer`;
  }
  end = end - 1;
  while (end > 0 && nativeType.byteAt(end - 1) == 32) {
    end = end - 1;
  }
  return nativeType.copyBytes(0, end);
}

struct NativeScalarPointerShape {
  typeName: String;
  constant: boolean;
}

function scalarPointerShape(
  in declarations: RawForeignModuleDeclarations,
  in nativeType: String
): Option<NativeScalarPointerShape> {
  if (pointerStarCount(nativeType) != 1) {
    return Option<NativeScalarPointerShape>.none;
  }
  const pointeeOutcome = attempt removeTrailingPointer(nativeType);
  let pointee = "";
  match (pointeeOutcome) {
    success(value) => pointee = move value;
    failure(_) => return Option<NativeScalarPointerShape>.none;
  }
  let stripped = TextBuffer();
  let constant = false;
  let wroteWord = false;
  let index: usize = 0;
  while (index < pointee.byteLength) {
    while (index < pointee.byteLength && pointee.byteAt(index) == 32) {
      index = index + 1;
    }
    if (index >= pointee.byteLength) break;
    const start = index;
    while (index < pointee.byteLength && pointee.byteAt(index) != 32) {
      index = index + 1;
    }
    const word = pointee.copyBytes(start, index);
    if (word == "const") {
      constant = true;
      continue;
    }
    if (
      word == "volatile"
      || word == "restrict"
      || word == "_Atomic"
    ) continue;
    if (wroteWord) stripped.append(" ");
    stripped.append(word);
    wroteWord = true;
  }
  const strippedName = stripped.finish();
  const scalar = attempt scalarTypeNameWithCanonical(
    declarations,
    strippedName,
    Option<String>.none
  );
  match (scalar) {
    success(typeName) => return Option.some(NativeScalarPointerShape({
      typeName,
      constant,
    }));
    failure(_) => return Option<NativeScalarPointerShape>.none;
  }
}

function resolvedScalarPointerShape(
  in declarations: RawForeignModuleDeclarations,
  in nativeType: String,
  in canonicalNativeType: Option<String>
): Option<NativeScalarPointerShape> {
  const direct = scalarPointerShape(declarations, nativeType);
  match (direct) {
    some(shape) => return Option.some(move shape);
    none => {}
  }
  match (in canonicalNativeType) {
    some(canonical) => return scalarPointerShape(declarations, canonical);
    none => return Option<NativeScalarPointerShape>.none;
  }
}

function opaqueHandleName(in pointerType: String): String throws String {
  let end = pointerType.byteLength;
  while (end > 0 && pointerType.byteAt(end - 1) == 32) {
    end = end - 1;
  }
  if (end == 0 || pointerType.byteAt(end - 1) != 42) {
    throw `native handle type ${pointerType} is not a pointer`;
  }
  end = end - 1;
  while (end > 0 && pointerType.byteAt(end - 1) == 32) {
    end = end - 1;
  }
  const wordEnd = end;
  while (end > 0) {
    const byte = pointerType.byteAt(end - 1);
    const identifier = (byte >= 48 && byte <= 57)
      || (byte >= 65 && byte <= 90)
      || (byte >= 97 && byte <= 122)
      || byte == 95;
    if (!identifier) break;
    end = end - 1;
  }
  if (end == wordEnd) {
    throw `native handle type ${pointerType} has no source-nameable pointee`;
  }
  return pointerType.copyBytes(end, wordEnd);
}

function normalizedHandleTypeIndex(
  in types: Array<NativeForeignTypeContract>,
  in nativeType: String
): Option<usize> {
  let index: usize = 0;
  while (index < types.length) {
    if (
      types[index].kind == "handle"
      && types[index].nativeName == nativeType
    ) return Option.some(index);
    index = index + 1;
  }
  return Option<usize>.none;
}

function handleSourceTypeName(
  in types: Array<NativeForeignTypeContract>,
  in nativeType: String,
  nullable: boolean
): String {
  match (normalizedHandleTypeIndex(types, nativeType)) {
    some(index) => {
      const name = types[index].name.copyBytes(
        0,
        types[index].name.byteLength
      );
      if (nullable) return `${name} | null`;
      return name;
    }
    none => return "";
  }
}

function validateHandleRelease(
  in declarations: RawForeignModuleDeclarations,
  in nativeType: String,
  in release: String
): void throws String {
  const releaseIndex = try findRawFunction(declarations, release);
  if (declarations.functions[releaseIndex].overloadCount != 1) {
    throw `native handle deinit "${release}" requires exactly one C overload`;
  }
  const overload = view declarations.overloads[
    declarations.functions[releaseIndex].overloadStart
  ];
  if (overload.parameterCount != 1 || overload.returnNativeType != "void") {
    throw `native handle deinit "${release}" must take one pointer value and return void`;
  }
  const parameter = view declarations.parameters[overload.parameterStart];
  let matches = parameter.nativeType == nativeType;
  match (in parameter.canonicalNativeType) {
    some(canonical) => {
      if (canonical == nativeType) matches = true;
    }
    none => {}
  }
  if (!matches) {
    throw `native handle deinit "${release}" consumes ${parameter.nativeType}, expected ${nativeType}`;
  }
}

function appendOwnedHandleType(
  in declarations: RawForeignModuleDeclarations,
  in nativeType: String,
  in release: String,
  inout types: Array<NativeForeignTypeContract>
): void throws String {
  if (pointerStarCount(nativeType) != 1) {
    throw `owned native handle ${nativeType} requires exactly one pointer indirection`;
  }
  match (normalizedHandleTypeIndex(types, nativeType)) {
    some(index) => {
      if (types[index].resourceRelease != release) {
        throw `native handle ${nativeType} has conflicting cleanup functions`;
      }
      return;
    }
    none => {}
  }
  try validateHandleRelease(declarations, nativeType, release);
  const name = try opaqueHandleName(nativeType);
  let replaceIndex = types.length;
  let typeIndex: usize = 0;
  while (typeIndex < types.length) {
    if (types[typeIndex].name == name && types[typeIndex].kind == "record") {
      replaceIndex = typeIndex;
      break;
    }
    typeIndex = typeIndex + 1;
  }
  const handle = NativeForeignTypeContract({
    kind: "handle",
    name: name.copyBytes(0, name.byteLength),
    nativeName: nativeType.copyBytes(0, nativeType.byteLength),
    underlyingType: "",
    layout: "opaque",
    resourceRelease: release.copyBytes(0, release.byteLength),
    fields: Array<NativeForeignFieldContract>(),
    viewOnly: false,
    discriminantMember: "",
    variants: Array<NativeForeignUnionVariant>(),
    fallback: "",
  });
  if (replaceIndex < types.length) types[replaceIndex] = move handle;
  else types.push(move handle);
}

function collectOwnedHandleTypes(
  in contracts: RawForeignContractSet,
  in declarations: RawForeignModuleDeclarations,
  inout types: Array<NativeForeignTypeContract>
): void throws String {
  for (const contract of contracts.functions) {
    const functionIndex = try findRawFunction(declarations, contract.name);
    if (declarations.functions[functionIndex].overloadCount != 1) {
      throw `native Z declaration handle tier requires exactly one overload for "${contract.name}"`;
    }
    const overload = view declarations.overloads[
      declarations.functions[functionIndex].overloadStart
    ];
    if (contract.resultRelease.byteLength > 0) {
      try appendOwnedHandleType(
        declarations,
        overload.returnNativeType,
        contract.resultRelease,
        inout types
      );
    }
    let parameterIndex: usize = 0;
    while (parameterIndex < contract.parameters.length) {
      const parameter = view contract.parameters[parameterIndex];
      if (parameter.release.byteLength > 0) {
        if (parameter.capability != "out") {
          throw `owned native handle output "${parameter.name}" requires the out capability`;
        }
        if (parameterIndex >= overload.parameterCount) {
          throw `owned native handle output "${parameter.name}" has no matching C parameter`;
        }
        const raw = view declarations.parameters[
          overload.parameterStart + parameterIndex
        ];
        if (pointerStarCount(raw.nativeType) != 2) {
          throw `owned native handle output "${parameter.name}" requires a C pointer-to-pointer`;
        }
        const producedType = try removeTrailingPointer(raw.nativeType);
        try appendOwnedHandleType(
          declarations,
          producedType,
          parameter.release,
          inout types
        );
      }
      parameterIndex = parameterIndex + 1;
    }
  }
}

function appendBorrowedHandleType(
  in nativeType: String,
  inout types: Array<NativeForeignTypeContract>
): void throws String {
  if (pointerStarCount(nativeType) != 1) return;
  match (normalizedHandleTypeIndex(types, nativeType)) {
    some(_) => return;
    none => {}
  }
  const name = try opaqueHandleName(nativeType);
  let replaceIndex = types.length;
  let typeIndex: usize = 0;
  while (typeIndex < types.length) {
    if (types[typeIndex].name == name && types[typeIndex].kind == "record") {
      replaceIndex = typeIndex;
      break;
    }
    typeIndex = typeIndex + 1;
  }
  const handle = NativeForeignTypeContract({
    kind: "handle",
    name: name.copyBytes(0, name.byteLength),
    nativeName: nativeType.copyBytes(0, nativeType.byteLength),
    underlyingType: "",
    layout: "opaque",
    resourceRelease: "",
    fields: Array<NativeForeignFieldContract>(),
    viewOnly: false,
    discriminantMember: "",
    variants: Array<NativeForeignUnionVariant>(),
    fallback: "",
  });
  if (replaceIndex < types.length) types[replaceIndex] = move handle;
  else types.push(move handle);
}

function collectBorrowedHandleTypes(
  in contracts: RawForeignContractSet,
  in declarations: RawForeignModuleDeclarations,
  inout types: Array<NativeForeignTypeContract>
): void throws String {
  for (const contract of contracts.functions) {
    if (contract.resultOwnership != "borrowed") continue;
    const functionIndex = try findRawFunction(declarations, contract.name);
    if (declarations.functions[functionIndex].overloadCount != 1) {
      throw `native Z declaration handle tier requires exactly one overload for "${contract.name}"`;
    }
    const overload = view declarations.overloads[
      declarations.functions[functionIndex].overloadStart
    ];
    try appendBorrowedHandleType(overload.returnNativeType, inout types);
  }
}

function normalizedHandleParameter(
  in parameter: RawForeignContractParameter,
  in nativeType: String,
  in types: Array<NativeForeignTypeContract>
): Option<NativeForeignParameterContract> throws String {
  let handleNativeType = nativeType.copyBytes(0, nativeType.byteLength);
  if (parameter.release.byteLength > 0) {
    handleNativeType = try removeTrailingPointer(nativeType);
  }
  const typeName = handleSourceTypeName(
    types,
    handleNativeType,
    parameter.nullable
  );
  if (typeName.byteLength == 0) {
    return Option<NativeForeignParameterContract>.none;
  }
  let abiMode = parameter.capability.copyBytes(
    0,
    parameter.capability.byteLength
  );
  if (parameter.release.byteLength > 0) {
    if (parameter.capability != "out") {
      throw `owned native handle output "${parameter.name}" requires the out capability`;
    }
  } else {
    if (parameter.capability != "in" && parameter.capability != "move") {
      throw `native handle parameter "${parameter.name}" requires in or move capability`;
    }
    if (parameter.capability == "in") abiMode = "inValue";
  }
  return Option.some(NativeForeignParameterContract({
    name: parameter.name.copyBytes(0, parameter.name.byteLength),
    capability: parameter.capability.copyBytes(
      0,
      parameter.capability.byteLength
    ),
    abiMode,
    typeName,
    nullOnly: false,
    fixedValue: "",
  }));
}

function fixedConstantMatchesParameter(
  in declarations: RawForeignModuleDeclarations,
  constantIndex: usize,
  parameterIndex: usize
): boolean {
  const constantType = view declarations.constants[constantIndex].typeName;
  const parameter = view declarations.parameters[parameterIndex];
  if (constantType == parameter.nativeType) return true;
  match (in parameter.canonicalNativeType) {
    some(typeName) => {
      if (constantType == typeName) return true;
    }
    none => {}
  }
  const constantScalar = attempt scalarTypeNameWithCanonical(
    declarations,
    constantType,
    Option<String>.none
  );
  const parameterScalar = attempt scalarTypeNameWithCanonical(
    declarations,
    parameter.nativeType,
    parameter.canonicalNativeType
  );
  let constantName = "";
  match (constantScalar) {
    success(name) => constantName = move name;
    failure(_) => return false;
  }
  let parameterName = "";
  match (parameterScalar) {
    success(name) => parameterName = move name;
    failure(_) => return false;
  }
  return constantName == parameterName;
}

function foreignTypeContractDeclarationIndex(
  in declarations: RawForeignModuleDeclarations,
  in name: String
): usize throws String {
  let index: usize = 0;
  while (index < declarations.types.length) {
    const declaration = view declarations.types[index];
    if (
      declaration.exportName == name
      || declaration.qualifiedName == name
      || declaration.nativeName == name
      || rawForeignCanonicalRecordName(declaration) == name
    ) return index;
    index = index + 1;
  }
  throw `declaration names unknown foreign type "${name}"`;
}

function nativeForeignFieldIndex(
  in fields: Array<NativeForeignFieldContract>,
  in name: String
): Option<usize> {
  let index: usize = 0;
  while (index < fields.length) {
    if (fields[index].name == name) return Option<usize>.some(index);
    index = index + 1;
  }
  return Option<usize>.none;
}

function nativeForeignConstantIndex(
  in constants: Array<NativeForeignConstantContract>,
  in name: String
): Option<usize> {
  let index: usize = 0;
  while (index < constants.length) {
    if (constants[index].name == name) return Option<usize>.some(index);
    index = index + 1;
  }
  return Option<usize>.none;
}

function attachDiscriminatedUnionContracts(
  in contracts: RawForeignContractSet,
  in declarations: RawForeignModuleDeclarations,
  in constants: Array<NativeForeignConstantContract>,
  inout types: Array<NativeForeignTypeContract>
): void throws String {
  for (const contract of contracts.types) {
    if (contract.discriminantMember.byteLength == 0) continue;
    const declarationIndex = try foreignTypeContractDeclarationIndex(
      declarations,
      contract.name
    );
    const declaration = view declarations.types[declarationIndex];
    if (declaration.kind != "record" || declaration.layout != "union") {
      throw `discriminant contract for "${contract.name}" requires a native C union`;
    }
    const typeIndex = match (normalizedForeignTypeIndex(
      types,
      declaration.exportName
    )) {
      some(index) => index;
      none => throw `foreign discriminated union "${contract.name}" could not preserve its native layout`;
    };
    const tagFieldIndex = match (nativeForeignFieldIndex(
      types[typeIndex].fields,
      contract.discriminantMember
    )) {
      some(index) => index;
      none => throw `native union "${contract.name}" has no supported discriminator member "${contract.discriminantMember}"`;
    };
    const tagType = view types[typeIndex].fields[tagFieldIndex].typeName;
    if (!isIntegerTypeName(tagType)) {
      let nominalInteger = false;
      for (const candidate of types) {
        if (
          candidate.name == tagType
          && candidate.kind == "enum"
          && isIntegerTypeName(candidate.underlyingType)
        ) nominalInteger = true;
      }
      if (!nominalInteger) {
        throw `native union discriminator "${contract.discriminantMember}" must be an integer scalar or nominal enum`;
      }
    }
    let variants = Array<NativeForeignUnionVariant>();
    for (const variant of contract.variants) {
      let payloadType = "";
      if (variant.member.byteLength > 0) {
        const payloadFieldIndex = match (nativeForeignFieldIndex(
          types[typeIndex].fields,
          variant.member
        )) {
          some(index) => index;
          none => throw `native union "${contract.name}" has no safely representable member "${variant.member}"`;
        };
        payloadType = types[typeIndex].fields[
          payloadFieldIndex
        ].typeName.copyBytes(
          0,
          types[typeIndex].fields[payloadFieldIndex].typeName.byteLength
        );
        const payloadIndex = match (normalizedForeignTypeIndex(
          types,
          payloadType
        )) {
          some(index) => index;
          none => throw `discriminated-union member "${variant.member}" must contain a cleanup-free native struct payload`;
        };
        if (
          types[payloadIndex].kind != "record"
          || types[payloadIndex].layout != "struct"
          || types[payloadIndex].resourceRelease.byteLength > 0
        ) {
          throw `discriminated-union member "${variant.member}" must contain a cleanup-free native struct payload`;
        }
      }
      let values = Array<String>();
      for (const value of variant.values) {
        const constantIndex = match (nativeForeignConstantIndex(
          constants,
          value
        )) {
          some(index) => index;
          none => throw `discriminated-union variant "${variant.name}" names unknown header constant "${value}"`;
        };
        const constantType = view constants[constantIndex].typeName;
        if (!isIntegerTypeName(constantType) && constantType != tagType) {
          throw `header constant "${value}" is incompatible with discriminator member "${contract.discriminantMember}"`;
        }
        values.push(constants[constantIndex].nativeName.copyBytes(
          0,
          constants[constantIndex].nativeName.byteLength
        ));
      }
      variants.push(NativeForeignUnionVariant({
        name: variant.name.copyBytes(0, variant.name.byteLength),
        member: variant.member.copyBytes(0, variant.member.byteLength),
        payloadType,
        values,
      }));
    }
    types[typeIndex].discriminantMember = contract.discriminantMember.copyBytes(
      0,
      contract.discriminantMember.byteLength
    );
    types[typeIndex].variants = move variants;
    types[typeIndex].fallback = contract.fallback.copyBytes(
      0,
      contract.fallback.byteLength
    );
  }
}

function foreignLifetimeExists(
  in contracts: RawForeignContractSet,
  in name: String
): boolean {
  for (const lifetime of contracts.lifetimes) {
    if (lifetime == name) return true;
  }
  return false;
}

function attachFieldProjectionContracts(
  in contracts: RawForeignContractSet,
  in declarations: RawForeignModuleDeclarations,
  inout types: Array<NativeForeignTypeContract>
): void throws String {
  for (const contract of contracts.types) {
    if (contract.fieldProjections.length == 0) continue;
    const declarationIndex = try foreignTypeContractDeclarationIndex(
      declarations,
      contract.name
    );
    const declaration = view declarations.types[declarationIndex];
    if (declaration.kind != "record" || declaration.layout != "struct") {
      throw `field projection for "${contract.name}" requires a native C struct`;
    }
    const typeIndex = match (normalizedForeignTypeIndex(
      types,
      declaration.exportName
    )) {
      some(index) => index;
      none => throw `field projection for "${contract.name}" requires a preserved native struct layout`;
    };
    for (const projection of contract.fieldProjections) {
      if (!foreignLifetimeExists(contracts, projection.lifetime)) {
        throw `projected field "${projection.name}" names unknown foreign lifetime "${projection.lifetime}"`;
      }
      let rawFieldIndex = declarations.fields.length;
      let index: usize = 0;
      while (index < declaration.fieldCount) {
        const candidateIndex = declaration.fieldStart + index;
        if (declarations.fields[candidateIndex].name == projection.name) {
          rawFieldIndex = candidateIndex;
          break;
        }
        index = index + 1;
      }
      if (rawFieldIndex >= declarations.fields.length) {
        throw `native struct "${contract.name}" has no field "${projection.name}"`;
      }
      const nativeType = view declarations.fields[rawFieldIndex].typeName;
      if (nativeType != "const char *" && nativeType != "char const *") {
        throw `projected field "${projection.name}" must be a native const char *, found "${nativeType}"`;
      }
      match (nativeForeignFieldIndex(types[typeIndex].fields, projection.name)) {
        some(_) => throw `projected field "${projection.name}" conflicts with an already representable native field`;
        none => {}
      }
      types[typeIndex].fields.push(NativeForeignFieldContract({
        name: projection.name.copyBytes(0, projection.name.byteLength),
        typeName: projection.typeName.copyBytes(0, projection.typeName.byteLength),
        lifetime: `foreign:${contracts.moduleSpecifier}:${projection.lifetime}`,
      }));
      types[typeIndex].viewOnly = true;
    }
  }
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
      Array<NativeForeignFieldContract>(),
      false
    ));
  }
  let recordAdded = true;
  while (recordAdded) {
    recordAdded = false;
    for (const declaration of declarations.types) {
      if (
        declaration.kind != "record"
        || (
          declaration.layout != "struct"
          && declaration.layout != "union"
        )
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
      let hiddenField = false;
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
        if (!represented && declaration.layout == "struct") {
          if (resourceRelease.byteLength == 0) {
            hiddenField = true;
          }
        }
        fieldIndex = fieldIndex + 1;
      }
      if (!compatible) continue;
      types.push(normalizedForeignType(
        declaration,
        resourceRelease,
        fields,
        declaration.layout == "struct"
          && resourceRelease.byteLength == 0
          && hiddenField
      ));
      recordAdded = true;
    }
  }
  try validateResourceContracts(contracts, declarations, types);
  try collectOwnedHandleTypes(contracts, declarations, inout types);
  try collectBorrowedHandleTypes(contracts, declarations, inout types);
  try attachFieldProjectionContracts(contracts, declarations, inout types);
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
  try attachDiscriminatedUnionContracts(
    contracts,
    declarations,
    constants,
    inout types
  );
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
    let parameters = Array<NativeForeignParameterContract>();
    let parameterIndex: usize = 0;
    while (parameterIndex < contract.parameters.length) {
      const rawParameterIndex = declarations.overloads[
        overloadIndex
      ].parameterStart + parameterIndex;
      match (in declarations.parameters[rawParameterIndex].name) {
        some(nativeName) => {
          if (nativeName != contract.parameters[parameterIndex].name) {
            throw `Z declaration parameter "${contract.parameters[parameterIndex].name}" does not match Clang parameter "${nativeName}"`;
          }
        }
        none => {}
      }
      if (contract.parameters[parameterIndex].nullOnly) {
        if (
          pointerStarCount(
            declarations.parameters[rawParameterIndex].nativeType
          ) == 0
        ) {
          throw `null-only foreign parameter "${contract.parameters[parameterIndex].name}" requires a C pointer parameter`;
        }
        parameters.push(NativeForeignParameterContract({
          name: contract.parameters[parameterIndex].name.copyBytes(
            0,
            contract.parameters[parameterIndex].name.byteLength
          ),
          capability: "value",
          abiMode: "value",
          typeName: "null",
          nullOnly: true,
          fixedValue: "",
        }));
        parameterIndex = parameterIndex + 1;
        continue;
      }
      if (contract.parameters[parameterIndex].fixedValue.byteLength > 0) {
        const constantIndex = try findRawConstant(
          declarations,
          contract.parameters[parameterIndex].fixedValue
        );
        if (!fixedConstantMatchesParameter(
          declarations,
          constantIndex,
          rawParameterIndex
        )) {
          throw `fixed foreign constant "${contract.parameters[parameterIndex].fixedValue}" has type ${declarations.constants[constantIndex].typeName}, expected ${declarations.parameters[rawParameterIndex].nativeType} for parameter "${contract.parameters[parameterIndex].name}"`;
        }
        parameters.push(NativeForeignParameterContract({
          name: contract.parameters[parameterIndex].name.copyBytes(
            0,
            contract.parameters[parameterIndex].name.byteLength
          ),
          capability: "value",
          abiMode: "value",
          typeName: "",
          nullOnly: false,
          fixedValue: declarations.constants[constantIndex]
            .nativeName.copyBytes(
              0,
              declarations.constants[constantIndex].nativeName.byteLength
            ),
        }));
        parameterIndex = parameterIndex + 1;
        continue;
      }
      const scalarPointer = resolvedScalarPointerShape(
        declarations,
        declarations.parameters[rawParameterIndex].nativeType,
        declarations.parameters[rawParameterIndex].canonicalNativeType
      );
      match (scalarPointer) {
        some(shape) => {
          const capability = view contract.parameters[parameterIndex]
            .capability;
          if (
            capability == "in"
            || capability == "inout"
            || capability == "out"
          ) {
            if (contract.parameters[parameterIndex].release.byteLength > 0) {
              throw `scalar pointer parameter "${contract.parameters[parameterIndex].name}" cannot declare deinit`;
            }
            if (capability == "in" && !shape.constant) {
              throw `in scalar parameter "${contract.parameters[parameterIndex].name}" requires a const native pointer, found ${declarations.parameters[rawParameterIndex].nativeType}`;
            }
            if (capability != "in" && shape.constant) {
              throw `${capability} scalar parameter "${contract.parameters[parameterIndex].name}" requires a mutable native pointer, found ${declarations.parameters[rawParameterIndex].nativeType}`;
            }
            parameters.push(NativeForeignParameterContract({
              name: contract.parameters[parameterIndex].name.copyBytes(
                0,
                contract.parameters[parameterIndex].name.byteLength
              ),
              capability: capability.copyBytes(0, capability.byteLength),
              abiMode: capability.copyBytes(0, capability.byteLength),
              typeName: shape.typeName.copyBytes(
                0,
                shape.typeName.byteLength
              ),
              nullOnly: false,
              fixedValue: "",
            }));
            parameterIndex = parameterIndex + 1;
            continue;
          }
        }
        none => {}
      }
      const handleParameter = try normalizedHandleParameter(
        contract.parameters[parameterIndex],
        declarations.parameters[rawParameterIndex].nativeType,
        types
      );
      match (handleParameter) {
        some(parameter) => {
          parameters.push(move parameter);
          parameterIndex = parameterIndex + 1;
          continue;
        }
        none => {}
      }
      if (contract.parameters[parameterIndex].nullable) {
        throw `native Z declaration parameter "${contract.parameters[parameterIndex].name}" cannot be nullable in this tier`;
      }
      if (contract.parameters[parameterIndex].release.byteLength > 0) {
        throw `native Z declaration parameter "${contract.parameters[parameterIndex].name}" declares deinit but does not produce a supported opaque handle`;
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
            if (types[typeIndex].layout == "union") {
              throw `record value ${typeName} requires a scalar-field struct layout`;
            }
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
        nullOnly: false,
        fixedValue: "",
      }));
      parameterIndex = parameterIndex + 1;
    }
    let nativeReturnType = "";
    let borrowedHandleResult = false;
    let borrowedFromParameter = Option<usize>.none;
    let invalidatesParameters = Array<usize>();
    let invalidatesLifetimes = Array<String>();
    if (contract.resultBorrowedFrom.byteLength > 0) {
      let ownerIndex: usize = 0;
      while (
        ownerIndex < contract.parameters.length
        && contract.parameters[ownerIndex].name != contract.resultBorrowedFrom
      ) {
        ownerIndex = ownerIndex + 1;
      }
      if (ownerIndex == contract.parameters.length) {
        throw `borrowed result from "${contract.name}" names unknown owner parameter "${contract.resultBorrowedFrom}"`;
      }
      if (
        parameters[ownerIndex].capability != "in"
        || parameters[ownerIndex].abiMode != "inValue"
      ) {
        throw `borrowed result owner "${contract.resultBorrowedFrom}" must be a non-null opaque C handle`;
      }
      borrowedFromParameter = Option.some(ownerIndex);
    }
    if (
      contract.returnKind == "view-cstring"
      && contract.resultBorrowedFrom.byteLength == 0
    ) {
      let inferredOwner = contract.parameters.length;
      let inferredCount: usize = 0;
      let candidateIndex: usize = 0;
      while (candidateIndex < contract.parameters.length) {
        const rawParameter = view declarations.parameters[
          declarations.overloads[overloadIndex].parameterStart + candidateIndex
        ];
        if (
          contract.parameters[candidateIndex].capability == "in"
          && !contract.parameters[candidateIndex].nullable
          && pointerStarCount(rawParameter.nativeType) == 1
        ) {
          inferredOwner = candidateIndex;
          inferredCount = inferredCount + 1;
        }
        candidateIndex = candidateIndex + 1;
      }
      if (inferredCount != 1) {
        throw `borrowed text result from "${contract.name}" requires exactly one immutable pointer owner or an explicit borrowed from fact`;
      }
      borrowedFromParameter = Option.some(inferredOwner);
    }
    for (const invalidatedOwner of contract.invalidates) {
      let ownerIndex: usize = 0;
      while (
        ownerIndex < contract.parameters.length
        && contract.parameters[ownerIndex].name != invalidatedOwner
      ) {
        ownerIndex = ownerIndex + 1;
      }
      if (ownerIndex == contract.parameters.length) {
        if (!foreignLifetimeExists(contracts, invalidatedOwner)) {
          throw `invalidation on "${contract.name}" names unknown owner parameter or foreign lifetime "${invalidatedOwner}"`;
        }
        invalidatesLifetimes.push(
          `foreign:${contracts.moduleSpecifier}:${invalidatedOwner}`
        );
        continue;
      }
      if (
        parameters[ownerIndex].capability != "in"
        || parameters[ownerIndex].abiMode != "inValue"
      ) {
        throw `invalidated owner "${invalidatedOwner}" must be a non-null opaque C handle`;
      }
      invalidatesParameters.push(ownerIndex);
    }
    if (contract.returnKind == "status") {
      nativeReturnType = try statusScalarTypeName(
        declarations,
        declarations.overloads[overloadIndex].returnNativeType
      );
    } else if (contract.returnKind == "view-cstring") {
      if (!isCharacterPointerReturn(
        declarations.overloads[overloadIndex].returnNativeType,
        declarations.overloads[overloadIndex].returnCanonicalNativeType
      )) {
        throw `native borrowed text producer "${contract.name}" must return a character pointer`;
      }
      if (
        contract.resultOwnership.byteLength > 0
        && contract.resultOwnership != "borrowed"
      ) {
        throw `native borrowed text producer "${contract.name}" cannot declare ${contract.resultOwnership} ownership`;
      }
      if (contract.resultRelease.byteLength > 0) {
        throw `native borrowed text producer "${contract.name}" cannot declare a deinitializer`;
      }
      nativeReturnType = "cstring";
    } else if (contract.resultRelease.byteLength > 0) {
      nativeReturnType = handleSourceTypeName(
        types,
        declarations.overloads[overloadIndex].returnNativeType,
        contract.returnNullable
      );
      if (nativeReturnType.byteLength == 0) {
        throw `native handle producer "${contract.name}" does not return the pointer governed by deinit ${contract.resultRelease}`;
      }
    } else {
      if (contract.resultOwnership == "borrowed") {
        nativeReturnType = handleSourceTypeName(
          types,
          declarations.overloads[overloadIndex].returnNativeType,
          contract.returnNullable
        );
        borrowedHandleResult = nativeReturnType.byteLength > 0;
      }
      if (!borrowedHandleResult) {
        if (contract.returnNullable) {
          throw `native Z declaration scalar result "${contract.name}" cannot be nullable`;
        }
        nativeReturnType = try foreignValueTypeName(
          declarations,
          types,
          declarations.overloads[overloadIndex].returnNativeType,
          declarations.overloads[overloadIndex].returnCanonicalNativeType
        );
        match (normalizedForeignTypeIndex(types, nativeReturnType)) {
          some(typeIndex) => {
            if (types[typeIndex].layout == "union") {
              throw `record value ${nativeReturnType} requires a scalar-field struct layout`;
            }
          }
          none => {}
        }
      }
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
    } else if (contract.returnKind == "view-cstring") {
      returnType = "view cstring";
      if (contract.returnNullable) returnType = `${returnType} | null`;
    } else if (borrowedHandleResult) {
      returnType = `view ${nativeReturnType}`;
    } else if (contract.resultRelease.byteLength == 0) {
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
      borrowedFromParameter,
      invalidatesParameters,
      invalidatesLifetimes,
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
