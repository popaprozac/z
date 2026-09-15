// Store a signed status code inside an unsigned tagged value. Numeric
// construction preserves values; toBits/fromBits preserve representations.
function packStatus(code: i32): u64 {
  const tag: u64 = 0x2A;
  return (tag << 32) | u64(code.toBits());
}

function unpackStatus(packed: u64): i32 {
  const payload = u32(packed & 0xFFFF_FFFF);
  return i32.fromBits(payload);
}

function observe(inout calls: i32): i32 {
  calls = calls + 1;
  return -42;
}

function observeBits(inout calls: i32): u32 {
  calls = calls + 1;
  return 0xFFFF_FFD6;
}

function main(): i32 {
  const negative: i32 = -42;
  const bits: u32 = negative.toBits();
  if (bits != 0xFFFF_FFD6 || negative != -42) return 1;
  if (i32.fromBits(bits) != negative) return 2;
  if (unpackStatus(packStatus(negative)) != negative) return 3;
  if (unpackStatus(packStatus(42)) != 42) return 4;

  // All signed widths use the corresponding unsigned bit carrier.
  if (i8.fromBits(0x80) != -128 || i8.fromBits(0xFF) != -1) return 5;
  if (i16.fromBits(0x8000) != -32768 || i16.fromBits(0xFFFF) != -1) return 6;
  if (i32.fromBits(0x8000_0000) != -2147483648) return 7;
  if (i64.fromBits(0x8000_0000_0000_0000) != -9223372036854775808) return 8;
  if (i64.fromBits(0xFFFF_FFFF_FFFF_FFFF) != -1) return 9;
  const nativeNegative: isize = -1;
  const nativeBits: usize = nativeNegative.toBits();
  if (isize.fromBits(nativeBits) != nativeNegative) return 10;

  // Every byte pattern round-trips, including those above signed maximum.
  let byte: usize = 0;
  while (byte < 256) {
    const pattern = u8(byte);
    if (i8.fromBits(pattern).toBits() != pattern) return 11;
    byte = byte + 1;
  }

  let calls = 0;
  const observed = observe(inout calls).toBits();
  if (calls != 1 || observed != bits) return 12;
  const restored = i32.fromBits(observeBits(inout calls));
  if (calls != 2 || restored != negative) return 13;
  return 0;
}
