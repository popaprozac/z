import console from "std/console";

function main(): i32 {
  const small: u8 = 42;
  const widened = i32(small);

  let values = Array<i32>();
  values.push(widened);
  values.push(22);

  const nativeCount = isize(values.length);
  const narrowed = u8(widened);

  console.log(`small=${narrowed}, native count=${nativeCount}`);
  return 0;
}
