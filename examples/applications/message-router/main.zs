import { Map } from "std/collections";
import console from "std/console";

struct Message {
  operation: String;
  value: i32;
}

struct RouteError {
  operation: String;
}

type Handler = (in message: Message) => i32 throws RouteError;

class RouteState {
  offset: i32;

  deinit {
    console.log(`released route state ${this.offset}`);
  }
}

function route(
  in handlers: Map<String, Handler>,
  in message: Message
): i32 throws RouteError {
  const found = handlers.get(message.operation);
  return match (in found) {
    some(handler) => try handler(in message);
    none => throw RouteError({ operation: copy message.operation });
  };
}

function main(): i32 {
  let handlers = Map<String, Handler>();

  const increment: Handler = (in message) => message.value + 1;
  handlers.set("increment", increment);

  const state = new RouteState({ offset: 20 });
  const addOffset: Handler = move (in message) => message.value + state.offset;
  handlers.set("offset", addOffset);

  const incrementMessage = Message({ operation: "increment", value: 41 });
  const offsetMessage = Message({ operation: "offset", value: 22 });
  const missingMessage = Message({ operation: "missing", value: 0 });
  const first = attempt route(in handlers, in incrementMessage);
  const second = attempt route(in handlers, in offsetMessage);
  const missing = attempt route(in handlers, in missingMessage);

  const firstValue = match (first) {
    success(value) => value;
    failure(_) => 0;
  };
  const secondValue = match (second) {
    success(value) => value;
    failure(_) => 0;
  };
  const missingOperation = match (missing) {
    success(_) => "unexpected";
    failure(error) => copy error.operation;
  };

  console.log(`increment=${firstValue} offset=${secondValue} missing=${missingOperation}`);
  return firstValue + secondValue - 84;
}
