import embed from "std/embed";
import Foundation from "Foundation/Foundation.h";

const PAYLOAD: embed.StaticBytes = embed.bytes("./assets/embedded-data.txt");

function main(): i32 {
  const data = Foundation.NSData.borrow(PAYLOAD);
  return data.length == PAYLOAD.length ? 0 : 1;
}
