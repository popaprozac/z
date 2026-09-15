function left_i8(value: i8, count: i8): i8 { return value << count; }
function right_i8(value: i8, count: i8): i8 { return value >> count; }

function left_u8(value: u8, count: u8): u8 { return value << count; }
function right_u8(value: u8, count: u8): u8 { return value >> count; }

function left_i16(value: i16, count: i16): i16 { return value << count; }
function right_i16(value: i16, count: i16): i16 { return value >> count; }

function left_u16(value: u16, count: u16): u16 { return value << count; }
function right_u16(value: u16, count: u16): u16 { return value >> count; }

function left_i32(value: i32, count: i32): i32 { return value << count; }
function right_i32(value: i32, count: i32): i32 { return value >> count; }

function left_u32(value: u32, count: u32): u32 { return value << count; }
function right_u32(value: u32, count: u32): u32 { return value >> count; }

function left_i64(value: i64, count: i64): i64 { return value << count; }
function right_i64(value: i64, count: i64): i64 { return value >> count; }

function left_u64(value: u64, count: u64): u64 { return value << count; }
function right_u64(value: u64, count: u64): u64 { return value >> count; }

function left_isize(value: isize, count: isize): isize { return value << count; }
function right_isize(value: isize, count: isize): isize { return value >> count; }

function left_usize(value: usize, count: usize): usize { return value << count; }
function right_usize(value: usize, count: usize): usize { return value >> count; }

function main(): i32 {
  if (left_i8(-1, 7) != -128) return 1;
  if (left_i8(-128, 0) != -128) return 2;
  if (right_i8(-128, 7) != -1) return 3;
  if (right_i8(-128, 0) != -128) return 4;
  if (right_i8(-3, 1) != -2) return 5;
  if (right_i8(-1, 0) != -1) return 6;
  if (left_u8(1, 7) != 128) return 7;
  if (left_u8(255, 0) != 255) return 8;
  if (right_u8(255, 7) != 1) return 9;
  if (right_u8(255, 0) != 255) return 10;
  if (left_i16(-1, 15) != -32768) return 1;
  if (left_i16(-32768, 0) != -32768) return 2;
  if (right_i16(-32768, 15) != -1) return 3;
  if (right_i16(-32768, 0) != -32768) return 4;
  if (right_i16(-3, 1) != -2) return 5;
  if (right_i16(-1, 0) != -1) return 6;
  if (left_u16(1, 15) != 32768) return 7;
  if (left_u16(65535, 0) != 65535) return 8;
  if (right_u16(65535, 15) != 1) return 9;
  if (right_u16(65535, 0) != 65535) return 10;
  if (left_i32(-1, 31) != -2147483648) return 1;
  if (left_i32(-2147483648, 0) != -2147483648) return 2;
  if (right_i32(-2147483648, 31) != -1) return 3;
  if (right_i32(-2147483648, 0) != -2147483648) return 4;
  if (right_i32(-3, 1) != -2) return 5;
  if (right_i32(-1, 0) != -1) return 6;
  if (left_u32(1, 31) != 2147483648) return 7;
  if (left_u32(4294967295, 0) != 4294967295) return 8;
  if (right_u32(4294967295, 31) != 1) return 9;
  if (right_u32(4294967295, 0) != 4294967295) return 10;
  if (left_i64(-1, 63) != -9223372036854775808) return 1;
  if (left_i64(-9223372036854775808, 0) != -9223372036854775808) return 2;
  if (right_i64(-9223372036854775808, 63) != -1) return 3;
  if (right_i64(-9223372036854775808, 0) != -9223372036854775808) return 4;
  if (right_i64(-3, 1) != -2) return 5;
  if (right_i64(-1, 0) != -1) return 6;
  if (left_u64(1, 63) != 9223372036854775808) return 7;
  if (left_u64(18446744073709551615, 0) != 18446744073709551615) return 8;
  if (right_u64(18446744073709551615, 63) != 1) return 9;
  if (right_u64(18446744073709551615, 0) != 18446744073709551615) return 10;
  if (left_isize(-1, 63) != -9223372036854775808) return 1;
  if (left_isize(-9223372036854775808, 0) != -9223372036854775808) return 2;
  if (right_isize(-9223372036854775808, 63) != -1) return 3;
  if (right_isize(-9223372036854775808, 0) != -9223372036854775808) return 4;
  if (right_isize(-3, 1) != -2) return 5;
  if (right_isize(-1, 0) != -1) return 6;
  if (left_usize(1, 63) != 9223372036854775808) return 7;
  if (left_usize(18446744073709551615, 0) != 18446744073709551615) return 8;
  if (right_usize(18446744073709551615, 63) != 1) return 9;
  if (right_usize(18446744073709551615, 0) != 18446744073709551615) return 10;
  return 0;
}
