import console from "std/console";

function sameAt<T>(in left: Array<T>, in right: Array<T>, index: usize): boolean {
  return left[index] == right[index];
}

function differentAt<T>(in left: Array<T>, in right: Array<T>, index: usize): boolean {
  return left[index] != right[index];
}

function main(): i32 {
  const bytes = Array<u8>(1, 2);
  const otherBytes = Array<u8>(1, 3);
  const units = Array<u16>(1, 257);
  const otherUnits = Array<u16>(1, 258);
  if (!sameAt<u8>(bytes, otherBytes, 0)) return 1;
  if (sameAt<u8>(bytes, otherBytes, 1)) return 2;
  if (differentAt<u8>(bytes, otherBytes, 0)) return 3;
  if (!differentAt<u8>(bytes, otherBytes, 1)) return 4;
  if (!sameAt<u16>(units, otherUnits, 0)) return 5;
  if (sameAt<u16>(units, otherUnits, 1)) return 6;
  if (differentAt<u16>(units, otherUnits, 0)) return 7;
  if (!differentAt<u16>(units, otherUnits, 1)) return 8;
  const texts = Array<String>("same", "left");
  const otherTexts = Array<String>("same", "right");
  if (!sameAt<String>(texts, otherTexts, 0)) return 9;
  if (sameAt<String>(texts, otherTexts, 1)) return 10;
  if (differentAt<String>(texts, otherTexts, 0)) return 11;
  if (!differentAt<String>(texts, otherTexts, 1)) return 12;
  console.log("ok");
  return 0;
}
