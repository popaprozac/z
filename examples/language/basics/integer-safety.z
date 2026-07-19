import console from "std/console";

function main(): i32 {
  const maximum: u8 = 255;
  const unsignedZero: u8 = 0;
  const minimum: i8 = -127;
  const wrapped = maximum.wrappingAdd(1);
  const wrappedLow = unsignedZero.wrappingSubtract(1);
  const wrappedProduct = maximum.wrappingMultiply(2);
  const saturatedHigh = maximum.saturatingAdd(1);
  const saturatedLow = minimum.saturatingSubtract(2);
  const saturatedProduct = maximum.saturatingMultiply(2);
  const quotient = 17 / 5;
  const remainder = 17 % 5;
  const negated = -quotient;
  const shifted = quotient << 2;
  const reduced = shifted >> 1;

  console.log(`wrapped=${wrapped},${wrappedLow},${wrappedProduct}, saturated=${saturatedHigh},${saturatedLow},${saturatedProduct}, division=${quotient},${remainder}, negated=${negated}, shifts=${shifted},${reduced}`);
  return 0;
}
