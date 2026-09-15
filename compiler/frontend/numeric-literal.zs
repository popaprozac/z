import { TextBuffer } from "std/text";

// Decimal, separator-free magnitudes; do not parse into a host integer before
// comparing, since an invalid source value may be wider than every Z integer.
export function integerLiteralFits(in value: String, in typeName: String): boolean {
  let maximum = "";
  const negative = value.byteLength > 0 && value.byteAt(0) == 45;
  if (typeName == "u8") maximum = "255";
  else if (typeName == "u16") maximum = "65535";
  else if (typeName == "u32") maximum = "4294967295";
  else if (typeName == "u64" || typeName == "usize") maximum = "18446744073709551615";
  else if (typeName == "i8") maximum = negative ? "128" : "127";
  else if (typeName == "i16") maximum = negative ? "32768" : "32767";
  else if (typeName == "i32") maximum = negative ? "2147483648" : "2147483647";
  else if (typeName == "i64" || typeName == "isize") maximum = negative ? "9223372036854775808" : "9223372036854775807";
  else return true;
  let start: usize = 0;
  if (value.byteLength > 0 && (value.byteAt(0) == 43 || negative)) start = 1;
  const length = value.byteLength - start;
  if (length == 0) return false;
  let index = start;
  let nonzero = false;
  while (index < value.byteLength) {
    const byte = value.byteAt(index);
    if (byte < 48 || byte > 57) return false;
    if (byte != 48) nonzero = true;
    index = index + 1;
  }
  if (negative && typeName.byteAt(0) == 117 && nonzero) return false;
  if (length != maximum.byteLength) return length < maximum.byteLength;
  index = 0;
  while (index < length) {
    const byte = value.byteAt(start + index);
    const limit = maximum.byteAt(index);
    if (byte != limit) return byte < limit;
    index = index + 1;
  }
  return true;
}

// Keep source spelling in tokens, and canonical decimal values in the AST.
// Radix conversion is unbounded so even overflowing literals reach the ordinary
// contextual range diagnostics instead of overflowing the compiler itself.
export function normalizeNumericLiteral(in spelling: String): String {
  let separator = false;
  let scan: usize = 0;
  while (scan < spelling.byteLength) {
    if (spelling.byteAt(scan) == 95) separator = true;
    scan = scan + 1;
  }
  if (!separator && (spelling.byteLength < 2 || spelling.byteAt(0) != 48)) {
    return spelling.copyBytes(0, spelling.byteLength);
  }
  let cleaned = TextBuffer();
  let offset: usize = 0;
  let floating = false;
  while (offset < spelling.byteLength) {
    const byte = spelling.byteAt(offset);
    if (byte != 95) cleaned.appendAscii(byte);
    if (byte == 46 || byte == 101 || byte == 69) floating = true;
    offset = offset + 1;
  }
  const value = cleaned.finish();
  let radix: usize = 0;
  if (value.byteLength > 2 && value.byteAt(0) == 48) {
    const prefix = value.byteAt(1);
    if (prefix == 120 || prefix == 88) radix = 16;
    if (prefix == 98 || prefix == 66) radix = 2;
  }
  if (radix == 0) {
    if (floating) return value;
    let start: usize = 0;
    while (start + 1 < value.byteLength && value.byteAt(start) == 48) {
      start = start + 1;
    }
    return value.copyBytes(start, value.byteLength);
  }
  // Little-endian decimal digits; all intermediate arithmetic is <= 159.
  let digits = Array<usize>();
  digits.push(0);
  offset = 2;
  while (offset < value.byteLength) {
    const byte = usize(value.byteAt(offset));
    let carry = byte - 48;
    if (byte >= 97) carry = byte - 87;
    else if (byte >= 65) carry = byte - 55;
    let index: usize = 0;
    while (index < digits.length) {
      const product = digits[index] * radix + carry;
      digits[index] = product % 10;
      carry = product / 10;
      index = index + 1;
    }
    while (carry > 0) {
      digits.push(carry % 10);
      carry = carry / 10;
    }
    offset = offset + 1;
  }
  let result = TextBuffer();
  let index = digits.length;
  while (index > 0) {
    index = index - 1;
    result.appendAscii(u8(digits[index] + 48));
  }
  return result.finish();
}
