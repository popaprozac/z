// Result bits wrap; shift counts remain checked and use usize.

function shift_i8(value: i8, count: usize): i8 {
  return value.wrappingShiftLeft(count);
}

function shift_u8(value: u8, count: usize): u8 {
  return value.wrappingShiftLeft(count);
}

function shift_i16(value: i16, count: usize): i16 {
  return value.wrappingShiftLeft(count);
}

function shift_u16(value: u16, count: usize): u16 {
  return value.wrappingShiftLeft(count);
}

function shift_i32(value: i32, count: usize): i32 {
  return value.wrappingShiftLeft(count);
}

function shift_u32(value: u32, count: usize): u32 {
  return value.wrappingShiftLeft(count);
}

function shift_i64(value: i64, count: usize): i64 {
  return value.wrappingShiftLeft(count);
}

function shift_u64(value: u64, count: usize): u64 {
  return value.wrappingShiftLeft(count);
}

function shift_isize(value: isize, count: usize): isize {
  return value.wrappingShiftLeft(count);
}

function shift_usize(value: usize, count: usize): usize {
  return value.wrappingShiftLeft(count);
}

type Word = u32;
struct Header { bits: Word; count: usize; }

function receiver(inout evaluations: i32): u32 {
  evaluations = evaluations + 1;
  return 3;
}
function count(inout evaluations: i32): usize {
  evaluations = evaluations + 1;
  return 31;
}

function main(): i32 {
  const value_i8: i8 = -1;
  if (shift_i8(value_i8, 0) != value_i8) return 1;
  if (shift_i8(value_i8, 7) != -128) return 2;
  if (shift_i8(value_i8, 1) != -2) return 3;
  const value_u8: u8 = 255;
  if (shift_u8(value_u8, 0) != value_u8) return 4;
  if (shift_u8(value_u8, 7) != 128) return 5;
  if (shift_u8(value_u8, 1) != 254) return 6;
  const value_i16: i16 = -1;
  if (shift_i16(value_i16, 0) != value_i16) return 7;
  if (shift_i16(value_i16, 15) != -32768) return 8;
  if (shift_i16(value_i16, 1) != -2) return 9;
  const value_u16: u16 = 65535;
  if (shift_u16(value_u16, 0) != value_u16) return 10;
  if (shift_u16(value_u16, 15) != 32768) return 11;
  if (shift_u16(value_u16, 1) != 65534) return 12;
  const value_i32: i32 = -1;
  if (shift_i32(value_i32, 0) != value_i32) return 13;
  if (shift_i32(value_i32, 31) != -2147483648) return 14;
  if (shift_i32(value_i32, 1) != -2) return 15;
  const value_u32: u32 = 4294967295;
  if (shift_u32(value_u32, 0) != value_u32) return 16;
  if (shift_u32(value_u32, 31) != 2147483648) return 17;
  if (shift_u32(value_u32, 1) != 4294967294) return 18;
  const value_i64: i64 = -1;
  if (shift_i64(value_i64, 0) != value_i64) return 19;
  if (shift_i64(value_i64, 63) != -9223372036854775808) return 20;
  if (shift_i64(value_i64, 1) != -2) return 21;
  const value_u64: u64 = 18446744073709551615;
  if (shift_u64(value_u64, 0) != value_u64) return 22;
  if (shift_u64(value_u64, 63) != 9223372036854775808) return 23;
  if (shift_u64(value_u64, 1) != 18446744073709551614) return 24;
  const value_isize: isize = -1;
  if (shift_isize(value_isize, 0) != value_isize) return 25;
  if (shift_isize(value_isize, 63) != -9223372036854775808) return 26;
  if (shift_isize(value_isize, 1) != -2) return 27;
  const value_usize: usize = 18446744073709551615;
  if (shift_usize(value_usize, 0) != value_usize) return 28;
  if (shift_usize(value_usize, 63) != 9223372036854775808) return 29;
  if (shift_usize(value_usize, 1) != 18446744073709551614) return 30;
  const header = Header({ bits: 3, count: 31 });
  const borrowed = view header.bits;
  const countView = view header.count;
  const shifted: Word = borrowed.wrappingShiftLeft(countView);
  if (shifted != 0x8000_0000 || header.bits != 3) return 31;
  if (borrowed.wrappingShiftLeft(1).wrappingShiftLeft(1) != 12) return 32;
  const optional = Option<view Word>.some(borrowed);
  const fromMatch = match (in optional) {
    some(bits) => bits.wrappingShiftLeft(31);
    none => u32(0);
  };
  if (fromMatch != shifted) return 33;
  if (borrowed.wrappingAdd(borrowed) != 6) return 35;
  let receiverEvaluations = 0;
  let countEvaluations = 0;
  const result = receiver(inout receiverEvaluations).wrappingShiftLeft(count(inout countEvaluations));
  if (receiverEvaluations != 1 || countEvaluations != 1 || result != shifted) return 34;
  return 0;
}
