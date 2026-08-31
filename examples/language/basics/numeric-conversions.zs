import console from "std/console";
import math from "std/math";

function main(): i32 {
  const small: u8 = 42;
  const widened = i32(small);

  let values = Array<i32>();
  values.push(widened);
  values.push(22);

  const nativeCount = isize(values.length);
  const narrowed = u8(widened);
  const measuredWidth = f64(nativeCount) + 0.75;
  const pixelWidth = u32(math.trunc(measuredWidth));

  console.log(`small=${narrowed}, measured=${measuredWidth}`);
  return i32(pixelWidth) - 2;
}
