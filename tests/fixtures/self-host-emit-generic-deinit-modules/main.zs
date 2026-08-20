import { Receipt as Record } from "./model.zs";

function main(): i32 {
  const receipt = Record<String>({ value: "ready", marker: 3 });
  return i32(receipt.value.byteLength) - 5;
}
