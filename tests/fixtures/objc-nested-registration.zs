import native from "objc-registration.h";
import objc from "std/objc";
import console from "std/console";
import { thread } from "std/thread";

class ChildHandler on thread.main implements native.ZRegistrationHandler {
  function receive(in owner: native.ZRegistrationOwner, value: i32): void
    as "registrationOwner:didReceiveValue:" {
    console.log(`received ${value}`);
  }
}

class ParentHandler on thread.main implements native.ZRegistrationHandler {
  function receive(in owner: native.ZRegistrationOwner, value: i32): void
    as "registrationOwner:didReceiveValue:" {
    const child = native.ZRegistrationOwner.alloc().init();
    const handler = new ChildHandler({});
    const adapter = objc.adapt<native.ZRegistrationHandler>(handler);
    const registration = objc.register({
      add: child.addHandler(handler, "child"),
      remove: child.removeHandlerForName("child"),
    });
    child.emitValue(value + 1);
  }
}

class Factory on thread.main {
  function install(in owner: native.ZRegistrationOwner): objc.Registration {
    const handler = new ParentHandler({});
    return objc.register({
      add: owner.addHandler(handler, "parent"),
      remove: owner.removeHandlerForName("parent"),
    });
  }
}

function main(): i32 {
  const owner = native.ZRegistrationOwner.alloc().init();
  const factory = new Factory({});
  const registration = factory.install(owner);
  owner.emitValue(41);
  return 0;
}
