import { Utf8Error } from "std/text";
import { scheduler } from "std/async";

async function main(): i32 throws Utf8Error {
  let bytes = Array<u8>(104, 105);
  const text = try String.fromBytes(bytes);
  bytes.clear();
  await scheduler.yield();
  if (bytes.length != 0) return 4;
  if (text != "hi") return 1;
  const invalid = Array<u8>(255);
  match (attempt String.fromBytes(invalid)) {
    success(_) => return 2;
    failure(error) => if (error.byteOffset != 0) return 3;
  }
  return 0;
}
