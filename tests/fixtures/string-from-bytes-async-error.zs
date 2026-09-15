import { Utf8Error } from "std/text";
import { scheduler } from "std/async";

async function main(): i32 throws Utf8Error {
  const bytes = Array<u8>(255);
  await scheduler.yield();
  const text = try String.fromBytes(bytes);
  return i32(text.byteLength);
}
