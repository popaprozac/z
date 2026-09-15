// Numeric constructors preserve mathematical values. These methods instead
// preserve representations: f64 <-> u64 and f32 <-> u32, without allocation.
function roundTrip64(bits: u64): boolean {
  return f64.fromBits(bits).toBits() == bits;
}

function roundTrip32(bits: u32): boolean {
  return f32.fromBits(bits).toBits() == bits;
}

function observe(inout calls: i32): f64 {
  calls = calls + 1;
  return 1.0;
}

function observeBits(inout calls: i32): u64 {
  calls = calls + 1;
  return 0x8000_0000_0000_0000;
}

function main(): i32 {
  const one: f64 = 1.0;
  const encoded = one.toBits();
  if (encoded != 0x3FF0_0000_0000_0000 || one != 1.0) return 1;
  if (f64.fromBits(encoded) != one) return 2;
  const narrow: f32 = 1.0;
  if (narrow.toBits() != 0x3F80_0000) return 3;

  // Both zero signs, infinities, NaN payloads, and subnormal values survive
  // the round trip. Arithmetic is not promised to preserve NaN payloads.
  if (!roundTrip64(0) || !roundTrip64(0x8000_0000_0000_0000)) return 4;
  if (!roundTrip64(0x7FF0_0000_0000_0000) || !roundTrip64(0xFFF0_0000_0000_0000)) return 5;
  if (!roundTrip64(0x7FF8_0000_0000_0042) || !roundTrip64(0xFFFF_FFFF_FFFF_FFFF)) return 6;
  if (!roundTrip64(1) || !roundTrip64(0x0010_0000_0000_0000)) return 7;
  if (!roundTrip32(0) || !roundTrip32(0x8000_0000)) return 8;
  if (!roundTrip32(0x7F80_0000) || !roundTrip32(0xFF80_0000)) return 9;
  if (!roundTrip32(0x7FC0_0042) || !roundTrip32(0xFFFF_FFFF)) return 10;
  if (!roundTrip32(1) || !roundTrip32(0x0080_0000)) return 11;

  let calls = 0;
  const observed = observe(inout calls).toBits();
  if (calls != 1 || observed != encoded) return 12;
  const restoredOnce = f64.fromBits(observeBits(inout calls));
  if (calls != 2 || restoredOnce.toBits() != 0x8000_0000_0000_0000) return 13;
  // Signaling-NaN encodings are copied, not processed arithmetically.
  if (!roundTrip64(0x7FF0_0000_0000_0042) || !roundTrip32(0x7F80_0042)) return 14;
  return 0;
}
