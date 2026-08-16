import { Map } from "std/collections";

export struct Message {
  operation: String;
  value: i32;
}

export struct RouteError {
  operation: String;
}

export type Handler = (in message: Message) => i32 throws RouteError;

export class Router {
  handlers: Map<String, Handler>;

  function register(inout this, name: String, handler: Handler): void {
    this.handlers.set(move name, handler);
  }

  function dispatch(in message: Message): i32 throws RouteError {
    const found = this.handlers.get(message.operation);
    return match (in found) {
      some(handler) => try handler(in message);
      none => throw RouteError({ operation: copy message.operation });
    };
  }
}

export function createRouter(): Router {
  return new Router({ handlers: Map<String, Handler>() });
}
