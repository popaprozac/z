import { Map } from "std/collections";
import { thread } from "std/thread";

export class Item on thread.main {
  value: i32;
}

class Registry on thread.main {
  values: Map<String, Item>;
}

export readonly class Owner on thread.main {
  readonly registry: Registry;
}

export function createOwner(): Owner on thread.main {
  let values = Map<String, Item>();
  values.set("answer", new Item({ value: 42 }));
  return new Owner({
    registry: new Registry({ values }),
  });
}
