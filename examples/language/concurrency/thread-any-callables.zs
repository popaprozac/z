import console from "std/console";
import { Map } from "std/collections";
import { thread } from "std/thread";

struct Message {
  operation: String;
  value: i32;
}

export type Handler = (in message: Message) => i32 on thread.any;

readonly class Offset {
  readonly value: i32;
}

readonly class Router {
  readonly handlers: readonly Map<String, Handler>;

  function dispatch(in message: Message): i32 {
    const found = this.handlers.get(message.operation);
    return match (in found) {
      some(handler) => handler(in message);
      none => -1;
    };
  }
}

function increment(in message: Message): i32 on thread.any {
  return message.value + 1;
}

function buildRouter(): Router {
  let handlers = Map<String, Handler>();
  const direct: Handler = increment;
  handlers.set("increment", direct);

  const offset = new Offset({ value: 20 });
  const captured: Handler = move (in message) => message.value + offset.value;
  handlers.set("offset", captured);

  return new Router({ handlers: handlers.freeze() });
}

async function main(): i32 {
  const router = buildRouter();
  const work = thread.spawn(move (): i32 => {
    const first = Message({ operation: "increment", value: 41 });
    const second = Message({ operation: "offset", value: 22 });
    return router.dispatch(in first) + router.dispatch(in second);
  });
  const answer = await work;
  console.log(`thread-any router answer=${answer}`);
  return answer - 84;
}
