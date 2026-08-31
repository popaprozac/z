import { Map } from "std/collections";
import { Handler, ImportedOffset, Message } from "./contracts.zs";

class Offset {
  value: i32;
}

struct Registry {
  handlers: Map<String, Handler>;

  function add(inout this, name: String, handler: Handler): void {
    this.handlers.set(move name, handler);
  }
}

function createIncrement(): Handler {
  const offset = new Offset({ value: 1 });
  return move (in message: Message): i32 => message.value + offset.value;
}

export function route(value: i32): i32 {
  let importedValues = Map<String, ImportedOffset>();
  importedValues.set("offset", new ImportedOffset({ value: 1 }));
  let importedTotal: i32 = 0;
  for (const entry of importedValues) {
    importedTotal = importedTotal + entry.value.value;
  }
  if (importedTotal != 1) return -2;
  let registry = Registry({ handlers: Map<String, Handler>() });
  const installed = createIncrement();
  registry.add("increment", installed);
  registry.add("alsoIncrement", installed);
  const found = registry.handlers.get("increment");
  match (in found) {
    some(handler) => {
      const selected: Handler = handler;
      const message = Message({ value });
      return selected(in message);
    }
    none => return -1;
  }
}
