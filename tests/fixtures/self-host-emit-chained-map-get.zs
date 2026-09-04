import { Map } from "std/collections";

class Item {
  value: i32;
}

class Registry {
  values: Map<String, Item>;
}

class Owner {
  registry: Registry;
}

function main(): i32 {
  let values = Map<String, Item>();
  values.set("answer", new Item({ value: 42 }));
  const owner = new Owner({
    registry: new Registry({ values }),
  });
  const found = owner.registry.values.get("answer");
  const observed = match (in found) {
    some(item) => item.value;
    none => 1;
  };
  return observed - 42;
}
