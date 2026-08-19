import console from "std/console";
import {
  clearRetainedOperation,
  invokeRetainedOperation,
  retainOperation
} from "../../interop/c/callbacks.h";
import {
  Handler,
  Message,
  Router,
  createRouteRegistry,
} from "./router.zs";

readonly class RouteState {
  readonly offset: i32;
}

function routeNative(in router: Router, value: i32): i32 {
  const message = Message({ operation: "offset", value });
  const routed = attempt router.dispatch(in message);
  return match (routed) {
    success(output) => output;
    failure(_) => -1;
  };
}

function installNativeDispatch(router: Router): void {
  retainOperation(move (value) => routeNative(router, value));
}

function main(): i32 {
  let routes = createRouteRegistry();
  const state = new RouteState({ offset: 20 });
  const addOffset: Handler = move (in message) => message.value + state.offset;
  routes.register("offset", addOffset);
  const router = routes.finish();
  installNativeDispatch(router);

  const routed = invokeRetainedOperation(22);
  clearRetainedOperation();

  console.log(`native callback routed=${routed}`);
  return routed - 42;
}
