import { executeCallback, makeEvents } from "./api.zs";
import console from "std/console";

function main(): i32 {
  const events = makeEvents(42);
  events.closed.notify(42, (in value: i32): void => {
    console.log(`event ${value}`);
  });
  executeCallback((): void => {
    console.log("constructed callback");
  });
  return events.closed.current() - 42;
}
