import console from "std/console";
import { Map, Set } from "std/collections";
import { thread } from "std/thread";

class RouteCatalog {
  // The field cannot be replaced, and the collections cannot be mutated.
  readonly handlers: readonly Map<String, i32>;
  readonly enabled: readonly Set<String>;
}

function buildCatalog(): RouteCatalog {
  let handlers = Map<String, i32>();
  handlers.set("open", 42);

  let enabled = Set<String>();
  enabled.add("open");

  return new RouteCatalog({
    handlers: handlers.freeze(),
    enabled: enabled.freeze(),
  });
}

async function main(): i32 {
  const catalog = buildCatalog();
  const lookup = thread.spawn(move () => (
    catalog.handlers.has("open") && catalog.enabled.has("open")
  ));

  const ready = await lookup;
  console.log(`published route ready=${ready}`);
  return ready ? 0 : 1;
}
