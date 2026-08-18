import { Map } from "std/collections";
import { thread } from "std/thread";

export struct Message {
  operation: String;
  value: i32;
}

export struct RouteError {
  operation: String;
}

export type Handler =
  (in message: Message) => i32 throws RouteError on thread.any;

export struct RouteRegistry {
  handlers: Map<String, Handler>;

  function register(inout this, name: String, handler: Handler): void {
    this.handlers.set(move name, handler);
  }

  function finish(move this): Router {
    return new Router({ handlers: this.handlers.freeze() });
  }
}

export readonly class Router {
  readonly handlers: readonly Map<String, Handler>;

  function dispatch(in message: Message): i32 throws RouteError {
    const found = this.handlers.get(message.operation);
    return match (in found) {
      some(handler) => try handler(in message);
      none => throw RouteError({ operation: copy message.operation });
    };
  }
}

export function createRouteRegistry(): RouteRegistry {
  return RouteRegistry({ handlers: Map<String, Handler>() });
}
