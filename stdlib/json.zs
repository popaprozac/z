import { Map } from "std/collections";
import { TextBuffer } from "std/text";

export enum JsonValue {
  nullValue,
  boolean boolean,
  number f64,
  string String,
  array Array<JsonValue>,
  object Map<String, JsonValue>,
}

export struct JsonError {
  message: String;
  offset: usize;
  line: usize;
  column: usize;
}

struct JsonCursor {
  offset: usize;
  line: usize;
  column: usize;
}

function parseError(in cursor: JsonCursor, message: String): JsonError {
  return JsonError({
    message: move message,
    offset: cursor.offset,
    line: cursor.line,
    column: cursor.column,
  });
}

function advance(in source: String, inout cursor: JsonCursor): u8 throws JsonError {
  if (cursor.offset >= source.byteLength) {
    throw parseError(cursor, "unexpected end of JSON input");
  }
  const byte = source.byteAt(cursor.offset);
  cursor.offset = cursor.offset + 1;
  if (byte == 13) {
    cursor.line = cursor.line + 1;
    cursor.column = 1;
  } else if (byte == 10) {
    if (cursor.offset < 2 || source.byteAt(cursor.offset - 2) != 13) {
      cursor.line = cursor.line + 1;
    }
    cursor.column = 1;
  } else if (byte < 128 || byte >= 192) {
    cursor.column = cursor.column + 1;
  }
  return byte;
}

function skipWhitespace(in source: String, inout cursor: JsonCursor): void throws JsonError {
  while (cursor.offset < source.byteLength) {
    const byte = source.byteAt(cursor.offset);
    if (byte != 32 && byte != 9 && byte != 10 && byte != 13) return;
    try advance(in source, inout cursor);
  }
}

function isDigit(byte: u8): boolean {
  return byte >= 48 && byte <= 57;
}

function decimalDigit(byte: u8): f64 {
  if (byte == 48) return 0.0;
  if (byte == 49) return 1.0;
  if (byte == 50) return 2.0;
  if (byte == 51) return 3.0;
  if (byte == 52) return 4.0;
  if (byte == 53) return 5.0;
  if (byte == 54) return 6.0;
  if (byte == 55) return 7.0;
  if (byte == 56) return 8.0;
  return 9.0;
}

function decimalDigitUsize(byte: u8): usize {
  if (byte == 48) return 0;
  if (byte == 49) return 1;
  if (byte == 50) return 2;
  if (byte == 51) return 3;
  if (byte == 52) return 4;
  if (byte == 53) return 5;
  if (byte == 54) return 6;
  if (byte == 55) return 7;
  if (byte == 56) return 8;
  return 9;
}

function hexDigit(byte: u8, in cursor: JsonCursor): u32 throws JsonError {
  if (byte >= 48 && byte <= 57) {
    if (byte == 48) return 0;
    if (byte == 49) return 1;
    if (byte == 50) return 2;
    if (byte == 51) return 3;
    if (byte == 52) return 4;
    if (byte == 53) return 5;
    if (byte == 54) return 6;
    if (byte == 55) return 7;
    if (byte == 56) return 8;
    return 9;
  }
  if (byte >= 65 && byte <= 70) {
    if (byte == 65) return 10;
    if (byte == 66) return 11;
    if (byte == 67) return 12;
    if (byte == 68) return 13;
    if (byte == 69) return 14;
    return 15;
  }
  if (byte >= 97 && byte <= 102) {
    if (byte == 97) return 10;
    if (byte == 98) return 11;
    if (byte == 99) return 12;
    if (byte == 100) return 13;
    if (byte == 101) return 14;
    return 15;
  }
  throw parseError(cursor, "expected a hexadecimal digit in Unicode escape");
}

function parseHexQuad(in source: String, inout cursor: JsonCursor): u32 throws JsonError {
  let value: u32 = 0;
  let index: usize = 0;
  while (index < 4) {
    const byte = try advance(in source, inout cursor);
    const digit = try hexDigit(byte, cursor);
    value = value * 16 + digit;
    index = index + 1;
  }
  return value;
}

function appendEscapedCodePoint(
  in source: String,
  inout cursor: JsonCursor,
  inout output: TextBuffer
): void throws JsonError {
  const high = try parseHexQuad(in source, inout cursor);
  if (high >= 55296 && high <= 56319) {
    if (
      cursor.offset + 2 > source.byteLength
      || source.byteAt(cursor.offset) != 92
      || source.byteAt(cursor.offset + 1) != 117
    ) {
      throw parseError(cursor, "a high surrogate must be followed by a low surrogate escape");
    }
    try advance(in source, inout cursor);
    try advance(in source, inout cursor);
    const low = try parseHexQuad(in source, inout cursor);
    if (low < 56320 || low > 57343) {
      throw parseError(cursor, "a high surrogate must be followed by a low surrogate escape");
    }
    output.appendCodePoint(65536 + (high - 55296) * 1024 + (low - 56320));
    return;
  }
  if (high >= 56320 && high <= 57343) {
    throw parseError(cursor, "an unpaired low surrogate is not valid JSON text");
  }
  output.appendCodePoint(high);
}

function parseString(in source: String, inout cursor: JsonCursor): String throws JsonError {
  const opening = try advance(in source, inout cursor);
  if (opening != 34) {
    throw parseError(cursor, "expected a JSON string");
  }
  let output = TextBuffer();
  let segmentStart = cursor.offset;
  while (cursor.offset < source.byteLength) {
    const byte = source.byteAt(cursor.offset);
    if (byte == 34) {
      output.appendBytes(source, segmentStart, cursor.offset);
      try advance(in source, inout cursor);
      return output.finish();
    }
    if (byte < 32) {
      throw parseError(cursor, "an unescaped control character is not valid in a JSON string");
    }
    if (byte != 92) {
      try advance(in source, inout cursor);
      continue;
    }

    output.appendBytes(source, segmentStart, cursor.offset);
    try advance(in source, inout cursor);
    const escaped = try advance(in source, inout cursor);
    if (escaped == 34 || escaped == 47 || escaped == 92) {
      output.appendAscii(escaped);
    } else if (escaped == 98) {
      output.appendAscii(8);
    } else if (escaped == 102) {
      output.appendAscii(12);
    } else if (escaped == 110) {
      output.appendAscii(10);
    } else if (escaped == 114) {
      output.appendAscii(13);
    } else if (escaped == 116) {
      output.appendAscii(9);
    } else if (escaped == 117) {
      try appendEscapedCodePoint(in source, inout cursor, inout output);
    } else {
      throw parseError(cursor, "unknown JSON string escape");
    }
    segmentStart = cursor.offset;
  }
  throw parseError(cursor, "unterminated JSON string");
}

function consumeLiteral(
  in source: String,
  inout cursor: JsonCursor,
  in literal: String
): void throws JsonError {
  let index: usize = 0;
  while (index < literal.byteLength) {
    const byte = try advance(in source, inout cursor);
    if (byte != literal.byteAt(index)) {
      throw parseError(cursor, `expected ${literal}`);
    }
    index = index + 1;
  }
}

function parseNumber(in source: String, inout cursor: JsonCursor): f64 throws JsonError {
  let negative = false;
  if (source.byteAt(cursor.offset) == 45) {
    negative = true;
    try advance(in source, inout cursor);
    if (cursor.offset >= source.byteLength) {
      throw parseError(cursor, "expected a digit after the minus sign");
    }
  }

  let value = 0.0;
  if (source.byteAt(cursor.offset) == 48) {
    try advance(in source, inout cursor);
    if (cursor.offset < source.byteLength && isDigit(source.byteAt(cursor.offset))) {
      throw parseError(cursor, "a JSON number cannot contain a leading zero");
    }
  } else {
    if (!isDigit(source.byteAt(cursor.offset))) {
      throw parseError(cursor, "expected a JSON number");
    }
    while (cursor.offset < source.byteLength && isDigit(source.byteAt(cursor.offset))) {
      const digit = try advance(in source, inout cursor);
      value = value * 10.0 + decimalDigit(digit);
    }
  }

  if (cursor.offset < source.byteLength && source.byteAt(cursor.offset) == 46) {
    try advance(in source, inout cursor);
    if (cursor.offset >= source.byteLength || !isDigit(source.byteAt(cursor.offset))) {
      throw parseError(cursor, "expected a digit after the decimal point");
    }
    let scale = 0.1;
    while (cursor.offset < source.byteLength && isDigit(source.byteAt(cursor.offset))) {
      const digit = try advance(in source, inout cursor);
      value = value + decimalDigit(digit) * scale;
      scale = scale * 0.1;
    }
  }

  if (
    cursor.offset < source.byteLength
    && (source.byteAt(cursor.offset) == 101 || source.byteAt(cursor.offset) == 69)
  ) {
    try advance(in source, inout cursor);
    let exponentNegative = false;
    if (cursor.offset < source.byteLength && source.byteAt(cursor.offset) == 43) {
      try advance(in source, inout cursor);
    } else if (cursor.offset < source.byteLength && source.byteAt(cursor.offset) == 45) {
      exponentNegative = true;
      try advance(in source, inout cursor);
    }
    if (cursor.offset >= source.byteLength || !isDigit(source.byteAt(cursor.offset))) {
      throw parseError(cursor, "expected an exponent digit");
    }
    let exponent: usize = 0;
    while (cursor.offset < source.byteLength && isDigit(source.byteAt(cursor.offset))) {
      if (exponent > 400) {
        throw parseError(cursor, "JSON number exponent is outside the f64 range");
      }
      const digit = try advance(in source, inout cursor);
      exponent = exponent * 10 + decimalDigitUsize(digit);
    }
    while (exponent > 0) {
      if (exponentNegative) value = value / 10.0;
      else value = value * 10.0;
      exponent = exponent - 1;
    }
  }

  if (value > 1.7976931348623157e308) {
    throw parseError(cursor, "JSON number is outside the finite f64 range");
  }
  if (negative) return -value;
  return value;
}

function parseArray(
  in source: String,
  inout cursor: JsonCursor,
  depth: usize
): JsonValue throws JsonError {
  try advance(in source, inout cursor);
  try skipWhitespace(in source, inout cursor);
  let values = Array<JsonValue>();
  if (cursor.offset < source.byteLength && source.byteAt(cursor.offset) == 93) {
    try advance(in source, inout cursor);
    return JsonValue.array(move values);
  }
  while (true) {
    const value = try parseValue(in source, inout cursor, depth + 1);
    values.push(move value);
    try skipWhitespace(in source, inout cursor);
    if (cursor.offset >= source.byteLength) {
      throw parseError(cursor, "unterminated JSON array");
    }
    const separator = try advance(in source, inout cursor);
    if (separator == 93) return JsonValue.array(move values);
    if (separator != 44) throw parseError(cursor, "expected ',' or ']' in JSON array");
    try skipWhitespace(in source, inout cursor);
  }
  throw parseError(cursor, "unreachable JSON array parser state");
}

function parseObject(
  in source: String,
  inout cursor: JsonCursor,
  depth: usize
): JsonValue throws JsonError {
  try advance(in source, inout cursor);
  try skipWhitespace(in source, inout cursor);
  let fields = Map<String, JsonValue>();
  if (cursor.offset < source.byteLength && source.byteAt(cursor.offset) == 125) {
    try advance(in source, inout cursor);
    return JsonValue.object(move fields);
  }
  while (true) {
    if (cursor.offset >= source.byteLength || source.byteAt(cursor.offset) != 34) {
      throw parseError(cursor, "expected a string key in JSON object");
    }
    const key = try parseString(in source, inout cursor);
    try skipWhitespace(in source, inout cursor);
    if (cursor.offset >= source.byteLength) {
      throw parseError(cursor, "expected ':' after JSON object key");
    }
    const colon = try advance(in source, inout cursor);
    if (colon != 58) {
      throw parseError(cursor, "expected ':' after JSON object key");
    }
    try skipWhitespace(in source, inout cursor);
    const value = try parseValue(in source, inout cursor, depth + 1);
    fields.set(move key, move value);
    try skipWhitespace(in source, inout cursor);
    if (cursor.offset >= source.byteLength) {
      throw parseError(cursor, "unterminated JSON object");
    }
    const separator = try advance(in source, inout cursor);
    if (separator == 125) return JsonValue.object(move fields);
    if (separator != 44) throw parseError(cursor, "expected ',' or '}' in JSON object");
    try skipWhitespace(in source, inout cursor);
  }
  throw parseError(cursor, "unreachable JSON object parser state");
}

function parseValue(
  in source: String,
  inout cursor: JsonCursor,
  depth: usize
): JsonValue throws JsonError {
  try skipWhitespace(in source, inout cursor);
  if (depth > 512) throw parseError(cursor, "JSON nesting exceeds 512 levels");
  if (cursor.offset >= source.byteLength) {
    throw parseError(cursor, "expected a JSON value");
  }
  const byte = source.byteAt(cursor.offset);
  if (byte == 110) {
    try consumeLiteral(in source, inout cursor, "null");
    return JsonValue.nullValue;
  }
  if (byte == 116) {
    try consumeLiteral(in source, inout cursor, "true");
    return JsonValue.boolean(true);
  }
  if (byte == 102) {
    try consumeLiteral(in source, inout cursor, "false");
    return JsonValue.boolean(false);
  }
  if (byte == 34) {
    const text = try parseString(in source, inout cursor);
    return JsonValue.string(move text);
  }
  if (byte == 91) return try parseArray(in source, inout cursor, depth);
  if (byte == 123) return try parseObject(in source, inout cursor, depth);
  if (byte == 45 || isDigit(byte)) {
    const number = try parseNumber(in source, inout cursor);
    return JsonValue.number(number);
  }
  throw parseError(cursor, "expected a JSON value");
}

export function parse(in source: String): JsonValue throws JsonError {
  let cursor = JsonCursor({ offset: 0, line: 1, column: 1 });
  const value = try parseValue(in source, inout cursor, 0);
  try skipWhitespace(in source, inout cursor);
  if (cursor.offset != source.byteLength) {
    throw parseError(cursor, "unexpected trailing content after JSON value");
  }
  return move value;
}

function appendHexByte(inout output: TextBuffer, byte: u8): void {
  const high = byte / 16;
  const low = byte % 16;
  if (high < 10) output.appendAscii(48 + high);
  else output.appendAscii(87 + high);
  if (low < 10) output.appendAscii(48 + low);
  else output.appendAscii(87 + low);
}

function appendJsonString(in text: String, inout output: TextBuffer): void {
  output.appendAscii(34);
  let segmentStart: usize = 0;
  let offset: usize = 0;
  while (offset < text.byteLength) {
    const byte = text.byteAt(offset);
    if (byte >= 32 && byte != 34 && byte != 92) {
      offset = offset + 1;
      continue;
    }
    output.appendBytes(text, segmentStart, offset);
    if (byte == 34) output.append("\\\"");
    else if (byte == 92) output.append("\\\\");
    else if (byte == 8) output.append("\\b");
    else if (byte == 9) output.append("\\t");
    else if (byte == 10) output.append("\\n");
    else if (byte == 12) output.append("\\f");
    else if (byte == 13) output.append("\\r");
    else {
      output.append("\\u00");
      appendHexByte(inout output, byte);
    }
    offset = offset + 1;
    segmentStart = offset;
  }
  const textLength = text.byteLength;
  output.appendBytes(text, segmentStart, textLength);
  output.appendAscii(34);
}

function appendJsonValue(in value: JsonValue, inout output: TextBuffer): void {
  match (in value) {
    nullValue => output.append("null");
    boolean(flag) => output.append(flag ? "true" : "false");
    number(number) => {
      if (
        number != number
        || number > 1.7976931348623157e308
        || number < -1.7976931348623157e308
      ) output.append("null");
      else output.append(`${number}`);
    }
    string(text) => appendJsonString(in text, inout output);
    array(items) => {
      output.appendAscii(91);
      let first = true;
      for (const item of items) {
        if (!first) output.appendAscii(44);
        first = false;
        appendJsonValue(in item, inout output);
      }
      output.appendAscii(93);
    }
    object(fields) => {
      output.appendAscii(123);
      let first = true;
      for (const entry of fields) {
        if (!first) output.appendAscii(44);
        first = false;
        appendJsonString(in entry.key, inout output);
        output.appendAscii(58);
        appendJsonValue(in entry.value, inout output);
      }
      output.appendAscii(125);
    }
  }
}

export function stringify(in value: JsonValue): String {
  let output = TextBuffer();
  appendJsonValue(in value, inout output);
  return output.finish();
}
