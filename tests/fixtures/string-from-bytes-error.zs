import { Utf8Error as DecodeError } from "std/text";

function errorAt(offset: usize): DecodeError {
  return DecodeError({ byteOffset: offset });
}

function main(): i32 {
  const error = errorAt(7);
  return i32(error.byteOffset) - 7;
}
