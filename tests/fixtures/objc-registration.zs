import native from "objc-registration.h";
import objc from "std/objc";
import console from "std/console";
import { thread } from "std/thread";

class RegistrationHandler implements native.ZRegistrationHandler {
  function receive(
    in owner: native.ZRegistrationOwner,
    value: i32
  ): void as "registrationOwner:didReceiveValue:" {
    console.log(`received ${value}`);
  }
}

class RegistrationRoot on thread.main {
  owner: native.ZRegistrationOwner;
  registration: objc.Registration;
}

function publish(in owner: native.ZRegistrationOwner): void {
  owner.emitValue(42);
}

function main(): i32 {
  const owner = native.ZRegistrationOwner.alloc().init();
  const handler = new RegistrationHandler({});
  const registration = objc.register({
    add: owner.addHandler(handler, "bridge"),
    remove: owner.removeHandlerForName("bridge"),
  });
  const root = new RegistrationRoot({ owner, registration });
  publish(in owner);
  return 0;
}
