import { Map } from "std/collections";
import native from "../../../tests/fixtures/move-only.hpp";

function exerciseMap(): i32 {
  let resources = Map<String, native.zcpp.UniqueValue>();
  resources.set("primary", native.zcpp.UniqueValue(20));
  resources.set("primary", native.zcpp.UniqueValue(21));
  resources.set("secondary", native.zcpp.UniqueValue(22));
  resources.set("tertiary", native.zcpp.UniqueValue(23));
  resources.set("quaternary", native.zcpp.UniqueValue(24));
  resources.set("quinary", native.zcpp.UniqueValue(25));

  const found = resources.get("primary");
  const observed = match (in found) {
    some(resource) => resource.value();
    none => 0;
  };

  const removed = resources.remove("primary");
  const removedValue = match (in removed) {
    some(resource) => resource.value();
    none => 0;
  };

  if (!resources.delete("secondary")) return 1;
  return observed + removedValue - 42;
}

function main(): i32 {
  const result = exerciseMap();
  return result + native.zcpp.unique_live();
}
