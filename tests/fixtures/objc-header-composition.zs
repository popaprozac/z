import forward from "./objc-forward.h";
import complete from "./objc-subclass.h";
import objc from "std/objc";
import { thread } from "std/thread";

class Reader extends complete.ZSubclassFixture on thread.main {
  constructor() { super.initWithValue(0); }
  function observe(in object: complete.ZSubclassFixture): i32 as "observe:" {
    return object.value();
  }
}

function main(): i32 {
  complete.z_subclass_catch_abort();
  const object = forward.ZForwardFactory.makeObject();
  const completed: complete.ZSubclassFixture = object;
  if (object != completed || !(completed == object)) return 90;
  // No source annotation needed to complete the forward-declared native type.
  object.configuredValue = 42;
  if (object.value() != 21 || object.configuredValue != 42) return 1;
  const factory = forward.ZForwardFactory.new();
  const reader = new Reader();
  factory.registerTarget(reader, selector: objc.selector(Reader.observe));
  const observed = factory.fire(object);
  factory.invalidate();
  return observed - 21;
}
