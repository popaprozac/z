import console from "std/console";
import {
  clearRetainedOperation,
  invokeRetainedOperation,
  retainOperation
} from "../../interop/c/callbacks.h";
import { Handler, Message, Router, createRouter } from "./router.zs";

class RouteState {
  offset: i32;

  deinit {
    console.log(`released native route state ${this.offset}`);
  }
}

function installNativeDispatch(router: Router): void {
  const state = new RouteState({ offset: 20 });
  const addOffset: Handler = move (in message) => message.value + state.offset;
  router.register("offset", addOffset);

  retainOperation(move (value) => {
    const message = Message({ operation: "offset", value });
    const routed = attempt router.dispatch(in message);
    return match (routed) {
      success(output) => output;
      failure(_) => -1;
    };
  });
}

function main(): i32 {
  const router = createRouter();
  installNativeDispatch(move router);

  const routed = invokeRetainedOperation(22);
  clearRetainedOperation();

  console.log(`native callback routed=${routed}`);
  return routed - 42;
}
