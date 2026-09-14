import native from "objc-registration.h";
import console from "std/console";
import { thread } from "std/thread";

export class Handler on thread.main implements native.ZRegistrationHandler {
  function receive(in owner: native.ZRegistrationOwner, value: i32): void
    as "registrationOwner:didReceiveValue:" {
    console.log(`received ${value}`);
  }

  deinit { console.log("handler released"); }
}
