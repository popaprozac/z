import { Handler, currentState, handle } from "./handler.zs";
import { thread } from "std/thread";

function retainBorrowedHandler(
  in handler: Option<Handler>
): Option<Handler> {
  return match (in handler) {
    some(stored) => Option.some(stored);
    none => Option<Handler>.none;
  };
}

function main(): i32 on thread.main {
  const operation: Handler = handle;
  const available = Option.some(operation);
  const retained = retainBorrowedHandler(in available);
  const running = match (currentState()) {
    running => true;
    _ => false;
  };
  if (!running) return 1;
  return 0;
}
