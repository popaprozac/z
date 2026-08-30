import embed from "std/embed";

export const MESSAGE: embed.StaticBytes = embed.bytes("./assets/embedded-message.txt");

function firstByte(bytes: Slice<u8>): u8 {
  return bytes[0];
}

function main(): i32 {
  if (MESSAGE.length == 0) return 1;
  if (firstByte(MESSAGE) != 90) return 2;
  return 0;
}
