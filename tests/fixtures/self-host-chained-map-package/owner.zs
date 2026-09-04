import { Map } from "std/collections";
import { thread } from "std/thread";
import { Item } from "./item.zs";

class Registry on thread.main {
  values: readonly Map<String, Item>;
}

export readonly class Owner on thread.main {
  readonly registry: Registry;
}

export function createOwner(): Owner on thread.main {
  let values = Map<String, Item>();
  values.set("answer", new Item({ value: 42 }));
  return new Owner({
    registry: new Registry({ values: values.freeze() }),
  });
}

export function existingItem(in owner: Owner): Item on thread.main {
  const found = owner.registry.values.get("answer");
  return match (in found) {
    some(item) => item;
    none => new Item({ value: 0 });
  };
}
