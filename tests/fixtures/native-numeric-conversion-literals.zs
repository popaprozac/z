import console from "std/console";

function main(): i32 {
  const maximum = u64(18446744073709551615);
  const minimum = i8(-128);
  const small = u8(255);
  const wide = i64(-5);
  console.log(`${maximum} ${minimum} ${small} ${wide}`);
  return maximum == u64(0) ? 1 : 0;
}
