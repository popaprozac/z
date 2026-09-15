import { decode, DecodeError } from "./decode.zs";
import { Utf8Error } from "std/text";

function forward(bytes: Slice<u8>): String throws Utf8Error {
  return try decode(bytes);
}

function offset(in error: DecodeError): usize {
  return error.byteOffset;
}

function main(): i32 {
  const bytes = Array<u8>(65, 255);
  return match (attempt forward(bytes)) {
    success(_) => 1;
    failure(error) => offset(error) == 1 ? 0 : 2;
  };
}
