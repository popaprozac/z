import console from "std/console";
import {
  Handler,
  Message,
  createRouteRegistry,
} from "./router.zs";

readonly class RouteState {
  readonly offset: i32;
}

function main(): i32 {
  let routes = createRouteRegistry();

  const increment: Handler = (in message) => message.value + 1;
  routes.register("increment", increment);

  const state = new RouteState({ offset: 20 });
  const addOffset: Handler = move (in message) => message.value + state.offset;
  routes.register("offset", addOffset);
  const router = routes.finish();

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
