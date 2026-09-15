import console from "std/console";

// Keep the four most recent input bytes in a rolling word.
function appendByte(window: u32, byte: u8): u32 {
  return window.wrappingShiftLeft(8) | u32(byte);
}

function main(): i32 {
  const previous: u32 = 0xAB_12_34_56;
  const current = appendByte(previous, 0x78);
  if (current != 0x12_34_56_78 || previous != 0xAB_12_34_56) return 1;

  const negative: i32 = -1;
  const signBit = negative.wrappingShiftLeft(31);
  if (signBit != -2147483648) return 2;

  // previous << 8 would trap: ordinary shifts require the full result to fit.
  // previous.wrappingShiftLeft(32) is an error: the count never wraps.
  console.log("Rolling word and signed bit shift verified");
  return 0;
}
