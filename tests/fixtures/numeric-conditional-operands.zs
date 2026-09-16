type Index = usize;

function choose(inout calls: i32, flag: boolean): boolean {
  calls = calls + 1;
  return flag;
}

function advance(index: Index, wide: boolean): Index {
  return index + (wide ? 2 : 1);
}

function main(): i32 {
  let index: usize = 0;
  index = index + (true ? 2 : 1);
  index = (false ? 2 : 1) + index;
  if (index != 3) return 1;
  if (advance(index, true) != 5) return 2;
  if (advance(index, false) != 4) return 3;

  const word: u64 = 0xFFFF_FFFF_FFFF_FFFF;
  if (word != (true ? 0xFFFF_FFFF_FFFF_FFFF : 0)) return 4;
  if ((false ? 0 : 0xFFFF_FFFF_FFFF_FFFF) != word) return 5;
  const signed: i64 = -0x8000_0000_0000_0000;
  if (signed != (true ? -0x8000_0000_0000_0000 : 0)) return 6;
  if ((false ? 0 : -0x8000_0000_0000_0000) != signed) return 7;

  const byte: u8 = 8;
  if (byte - (true ? 2 : 1) != 6) return 8;
  if ((false ? 3 : 16) / byte != 2) return 9;
  if (byte * (false ? 3 : 2) != 16) return 10;
  if (byte % (true ? 3 : 2) != 2) return 11;
  if (byte < (true ? 4 : 9)) return 12;
  if ((false ? 10 : 8) > byte) return 13;
  if ((byte | (true ? 1 : 2)) != 9) return 14;
  if (((false ? 1 : 3) ^ byte) != 11) return 15;
  if ((byte & (true ? 7 : 8)) != 0) return 16;
  if ((byte << (true ? 1 : 2)) != 16) return 17;

  const fraction: f32 = 1.5;
  const sum = fraction + (true ? 0.5 : 1.5);
  const reversed = (false ? 0.5 : 1.5) + fraction;
  if (sum != 2.0) return 18;
  if (reversed != 3.0) return 19;

  let calls: i32 = 0;
  const nested = index + (choose(inout calls, true)
    ? (choose(inout calls, false) ? 7 : 2) : 1);
  if (nested != 5 || calls != 2) return 20;
  const reverseNested = (choose(inout calls, false)
    ? 7 : (choose(inout calls, true) ? 2 : 1)) + index;
  if (reverseNested != 5 || calls != 4) return 21;
  return 0;
}
