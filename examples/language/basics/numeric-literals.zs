import console from "std/console";

// Spell bit patterns in the base that makes them easiest to review. The type,
// contextual range checks, and generated machine value do not change.
const tagMask: u64 = 0xFFF8_0000_0000_0000;
const signedMinimum: i64 = -0x8000_0000_0000_0000;
const scale = 1_024.5_0;

function preserve(value: i64): i64 { return value; }

function main(): i32 {
  const flags: u8 = 0b1010_0101;
  const capacity: usize = 1_024;
  const offsets: i32[0x3] = [10, 20, 12];
  const minimum: i8 = -0x80;
  const maximum: u64 = 0xFFFF_FFFF_FFFF_FFFF;
  const negative: i64 = -0x8000_0000_0000_0000;
  const exponentDigits = 0x1e5; // e is a hexadecimal digit, not an exponent.
  const decimal: i32 = 010; // Decimal, never implicit octal.
  const measured: f64 = 1_024.5_0e+0_1;

  if (flags != 165 || capacity != 1024) return 1;
  if (offsets[0b10] != 12 || minimum != -128) return 2;
  if (maximum != 18446744073709551615 || negative != -9223372036854775808) return 3;
  if (tagMask != 18444492273895866368 || exponentDigits != 485) return 4;
  if (decimal != 10 || measured != 10245.0) return 5;
  if (preserve(-0x8000_0000_0000_0000) != signedMinimum || scale != 1024.5) return 6;
  console.log("numeric literals: same values, clearer spelling");
  return 0;
}
