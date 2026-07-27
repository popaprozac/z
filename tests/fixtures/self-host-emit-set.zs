import { Set } from "std/collections";

function main(): i32 {
  let names = Set<String>();
  if (!names.add("alpha")) return 1;
  if (names.add("alpha")) return 2;
  if (names.length != 1) return 3;
  if (!names.has("alpha")) return 4;
  if (names.has("missing")) return 5;
  return 42;
}
