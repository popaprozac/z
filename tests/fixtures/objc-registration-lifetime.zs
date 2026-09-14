import native from "objc-registration.h";
import objc from "std/objc";
import console from "std/console";
import { thread } from "std/thread";
import { Handler } from "./objc-registration-handler.zs";

function registeredCall(): void on thread.main {
  const owner = native.ZRegistrationOwner.alloc().init();
  const handler = new Handler({});
  const registration = objc.register({
    add: owner.addHandler(handler, "bridge"),
    remove: owner.removeHandlerForName("bridge"),
  });
  owner.emitValue(42);
}

function main(): i32 on thread.main {
  registeredCall();
  console.log("scope returned");
  return 0;
}
