import { expect, expect as verify } from "std/test";

type Handle = u32;

test "numeric expectations use the comparison literal type" {
  const byte: u8 = 255;
  const word: u16 = 65535;
  const handle: u32 = 0xFFFF_FFFF;
  const wide: u64 = 0xFFFF_FFFF_FFFF_FFFF;
  const size: usize = 42;
  expect(byte).toEqual(255);
  expect(255).toEqual(byte);
  expect(word).toEqual(65535);
  expect(65535).toEqual(word);
  expect(handle).toEqual(0xFFFF_FFFF);
  expect(0xFFFF_FFFF).toEqual(handle);
  expect(wide).toEqual(0xFFFF_FFFF_FFFF_FFFF);
  expect(0xFFFF_FFFF_FFFF_FFFF).toEqual(wide);
  expect(in size).toEqual(42);
  expect(42).toEqual(in size);

  const tiny: i8 = -128;
  const small: i16 = -32768;
  const negative: i64 = -9223372036854775808;
  const index: isize = -42;
  expect(tiny).toEqual(-128);
  expect(-128).toEqual(tiny);
  expect(small).toEqual(-32768);
  expect(-32768).toEqual(small);
  expect(negative).toEqual(-9223372036854775808);
  expect(-9223372036854775808).toEqual(negative);
  expect(index).toEqual(-42);
  expect(-42).toEqual(index);

  const fraction: f32 = -1.5;
  expect(fraction).toEqual(-1.5);
  expect(-1.5).toEqual(fraction);
  const decimal: f32 = 0.1;
  expect(decimal).toEqual(0.1);
  expect(0.1).toEqual(decimal);
  expect(1).toEqual(1);
  expect(1.5).toEqual(1.5);

  verify(handle).toEqual(0xFFFF_FFFF);
  verify(0xFFFF_FFFF).toEqual(handle);

  const aliased: Handle = 0xFFFF_FFFF;
  expect(aliased).toEqual(0xFFFF_FFFF);
  expect(0xFFFF_FFFF).toEqual(aliased);
}
