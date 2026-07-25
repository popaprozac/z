import native from "./byte-buffer.h";

function main(): i32 {
  const bytes: u8[3] = [20, 21, 1];
  return native.z_byte_sum(bytes) - 42;
}
