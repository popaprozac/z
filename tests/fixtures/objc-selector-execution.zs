import native from "./objc-subclass.h";
import objc from "std/objc";
import { thread } from "std/thread";

class Receiver extends native.ZSubclassFixture on thread.main {
  private total: i32;
  constructor(value: i32) {
    super.initWithValue(value);
    this.total = value;
  }
  function receive(inout this, value: i32): i32 as "receive:" {
    this.total = this.total + value;
    return this.total;
  }
  function read(in object: native.ZSubclassFixture): i32 as "readFrom:" {
    return object.value();
  }
}

function exercise(): i32 on thread.main {
  const receiver = new Receiver(40);
  receiver.registerTarget(receiver, selector: objc.selector(Receiver.receive));
  const first = receiver.fireWithValue(1);
  const second = receiver.fireWithValue(1);
  receiver.registerObjectTarget(receiver, selector: objc.selector(Receiver.read));
  const observed = receiver.fireWithObject(receiver);
  receiver.invalidate();
  if (first != 41 || second != 42 || observed != 40 || receiver.fireWithValue(1) != -1) return 1;
  return 0;
}

function main(): i32 {
  native.z_subclass_catch_abort();
  let iteration: i32 = 0;
  while (iteration < 200) {
    if (exercise() != 0 || native.z_subclass_live_count() != 0) return 1;
    iteration = iteration + 1;
  }
  return 0;
}
