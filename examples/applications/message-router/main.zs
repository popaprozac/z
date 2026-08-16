import console from "std/console";
import { Handler, Message, createRouter } from "./router.zs";

class RouteState {
  offset: i32;

  deinit {
    console.log(`released route state ${this.offset}`);
  }
}

function main(): i32 {
  const router = createRouter();

  const increment: Handler = (in message) => message.value + 1;
  router.register("increment", increment);

  const state = new RouteState({ offset: 20 });
  const addOffset: Handler = move (in message) => message.value + state.offset;
  router.register("offset", addOffset);

  const incrementMessage = Message({ operation: "increment", value: 41 });
  const offsetMessage = Message({ operation: "offset", value: 22 });
  const missingMessage = Message({ operation: "missing", value: 0 });
  const first = attempt router.dispatch(in incrementMessage);
  const second = attempt router.dispatch(in offsetMessage);
  const missing = attempt router.dispatch(in missingMessage);

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
