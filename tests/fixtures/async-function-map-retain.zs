import { scheduler } from "std/async";
import { Map } from "std/collections";
import { thread } from "std/thread";

type Handler = async (in value: i32) => i32 on thread.any;

readonly class Incrementer {
  async function increment(in value: i32): i32 {
    await scheduler.yield();
    return value + 1;
  }
}

function createHandler(service: Incrementer): Handler {
  return async move (in value: i32): i32 =>
    await service.increment(in value);
}

readonly class Registry {
  readonly handlers: readonly Map<String, Handler>;

  async function invoke(name: String, value: i32): i32 {
    const found = this.handlers.get(name);
    const selected = match (in found) {
      some(stored) => Option.some(stored);
      none => Option<Handler>.none;
    };
    return match (selected) {
      some(handler) => await handler(in value);
      none => 0;
    };
  }
}

function createRegistry(): Registry {
  let handlers = Map<String, Handler>();
  handlers.set(
    "increment",
    createHandler(new Incrementer({}))
  );
  return new Registry({ handlers: handlers.freeze() });
}

async function main(): i32 {
  const registry = createRegistry();
  const first = await registry.invoke("increment", 20);
  const second = await registry.invoke("increment", 21);
  return first + second - 43;
}
