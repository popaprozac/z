import { Utf8Error as TextError } from "std/text";

export type DecodeError = TextError;

export function decode(bytes: Slice<u8>): String throws DecodeError {
  return try String.fromBytes(bytes);
}
