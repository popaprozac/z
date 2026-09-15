type TagBits = u64;
type Handle = u32;
type SignedByte = i8;

struct Header {
  tag: TagBits;
}

function chooseTag(flag: boolean): TagBits {
  return flag ? 0xFFFE << 48 : 6;
}

function acceptTag(value: TagBits): TagBits { return value; }

function main(): i32 {
  const mask: u64 = 0xFFFE << 48;
  if (mask != 0xFFFE_0000_0000_0000) return 1;
  if (chooseTag(true) != mask) return 2;
  if (chooseTag(false) != 6) return 3;
  const handle: Handle = 0xFFFF_FFFF;
  if (handle != 0xFFFF_FFFF) return 4;
  const minimum: SignedByte = -128;
  if (minimum != -128) return 5;
  const nested: u64 = true ? (false ? 0 : 0xFFFE << 48) : 1;
  if (nested != mask) return 6;
  let assigned: u64 = 0;
  assigned = true ? 0xFFFE << 48 : 0;
  if (assigned != mask) return 7;
  if (acceptTag(true ? 0xFFFE << 48 : 0) != mask) return 8;
  const header = Header({ tag: true ? 0xFFFE << 48 : 0 });
  if (header.tag != mask) return 9;
  const shifted: u64 = (0xFFFE << 48) >> 48;
  if (shifted != 0xFFFE) return 10;
  const inferred = true ? 7 : 6;
  const plain: i32 = inferred;
  if (plain != 7) return 11;
  const signed: i64 = true ? -0x8000_0000_0000_0000 : 0;
  if (signed != -0x8000_0000_0000_0000) return 12;
  const signBit: i64 = -1 << 63;
  if (signBit != signed) return 13;
  const negativeShift: i64 = (-3 << 2) >> 3;
  if (negativeShift != -2) return 14;
  const fraction: f32 = true ? -1.5 : 0.5;
  if (fraction != -1.5) return 15;
  return 0;
}
