import Foundation from "Foundation/Foundation.h";

function copiedLength(bytes: Slice<u8>): usize {
  const data = Foundation.NSData.copy(bytes);
  return data.length;
}

function main(): i32 {
  const bytes = Array<u8>(90, 32, 68, 97, 116, 97);
  return copiedLength(bytes) == 6 ? 0 : 1;
}
