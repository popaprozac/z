import native from "objc-registration-native.h";
import objc from "std/objc";
import console from "std/console";
import { thread } from "std/thread";

class NativeRegistrationHandler implements native.ZNativeRegistrationHandler {
  function receive(
    in owner: native.ZNativeRegistrationOwner,
    value: i32
  ): void as "registrationOwner:didReceiveValue:" {
    if (value == -1) owner.emitValue(value);
    console.log(`received ${value}`);
  }
}

class NativeRegistrationRoot on thread.main {
  owner: native.ZNativeRegistrationOwner;
  registration: objc.Registration;

  function publish(): void {
    this.owner.emitValue(42);
  }
}

function createRegistrationRoot(): NativeRegistrationRoot on thread.main {
  const owner = native.ZNativeRegistrationOwner.alloc().init();
  const handler = new NativeRegistrationHandler({});
  const registration = objc.register({
    add: owner.addHandler(handler, "bridge"),
    remove: owner.removeHandlerForName("bridge"),
  });
  return new NativeRegistrationRoot({ owner, registration });
}

function main(): i32 on thread.main {
  const root = createRegistrationRoot();
  root.publish();
  return 0;
}
