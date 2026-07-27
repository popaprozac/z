import { Map } from "std/collections";

function main(): i32 {
  let indices = Map<String, i32>();
  indices.set("first", 20);
  indices.set("answer", 22);
  indices.set("answer", 42);
  if (indices.length != 2) return 3;
  if (!indices.has("answer")) return 1;
  if (indices.has("missing")) return 4;
  const found = indices.get("answer");
  return match (in found) {
    some(value) => value;
    none => 2;
  };
}
