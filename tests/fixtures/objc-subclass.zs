import native from "./objc-subclass.h";
import { thread } from "std/thread";

class Counter extends native.ZSubclassFixture on thread.main {
  constructor(value: i32) {
    super.initWithValue(value);
    this.configuredValue = 1;
  }

  override function value(): i32 as "value" {
    return super.value() + 2;
  }

  override function sum(left: i32, right: i32): i32 as "add:to:" {
    return super.add(left, to: right) + 1;
  }
}

function exercise(): i32 on thread.main {
  const counter = new Counter(40);
  const base: native.ZSubclassFixture = counter;
  return base.readVirtualValue() + counter.sum(20, to: 21) + counter.configuredValue - 85;
}

function main(): i32 {
  let index: i32 = 0;
  while (index < 200) {
    if (exercise() != 0) return 1;
    index = index + 1;
  }
  return native.z_subclass_live_count();
}
