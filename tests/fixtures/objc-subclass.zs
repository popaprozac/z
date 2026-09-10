import native from "./objc-subclass.h";
import { thread } from "std/thread";

type ReadValue = () => i32 on thread.main;

struct BodyResource {
  text: String;
  deinit { native.z_subclass_leave_body(); }
}

class Counter extends native.ZSubclassFixture on thread.main {
  constructor(value: i32) {
    super.initWithValue(value);
    const configuration = (): i32 => {
      const initial = (): i32 => { return 1; };
      return initial();
    };
    this.configuredValue = configuration();
  }

  override function value(): i32 as "value" {
    native.z_subclass_enter_body();
    const source = "first second";
    const resource = BodyResource({ text: source.copyBytes(0, 5) });
    const length = (): usize => resource.text.byteLength;
    if (length() != 5) return -1;
    return super.value() + 2;
  }

  override function sum(left: i32, right: i32): i32 as "add:to:" {
    return super.add(left, to: right) + 1;
  }

  override function read(in object: native.ZSubclassFixture): i32 as "readObject:" {
    const callback: ReadValue = move (): i32 => object.value();
    return callback();
  }
}

function retainedReader(): ReadValue on thread.main {
  const counter = new Counter(40);
  return move (): i32 => counter.value();
}

function exerciseEscapingReader(): i32 on thread.main {
  const callback = retainedReader();
  if (native.z_subclass_live_count() != 1) return 2;
  return callback() - 42;
}

function exercise(): i32 on thread.main {
  const counter = new Counter(40);
  const base: native.ZSubclassFixture = counter;
  return base.readVirtualValue() + counter.sum(20, to: 21) + counter.configuredValue
    + counter.read(in base) - 127;
}

function main(): i32 {
  let index: i32 = 0;
  while (index < 200) {
    if (exercise() != 0) return 1;
    if (exerciseEscapingReader() != 0) return 2;
    if (native.z_subclass_body_balance() != 0) return 3;
    index = index + 1;
  }
  return native.z_subclass_live_count();
}
