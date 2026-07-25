import native from "./byte-buffer.h";

function main(): i32 {
  let bytes: u8[3] = [19, 20, 0];
  native.z_byte_increment(inout bytes);
  return native.z_byte_sum(bytes) - 42;
}
