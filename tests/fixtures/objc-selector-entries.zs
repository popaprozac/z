import native from "./objc-subclass.h";
import { thread } from "std/thread";

class Receiver extends native.ZSubclassFixture on thread.main {
  private total: i32;
  private title: String;
  constructor(value: i32) {
    super.initWithValue(value);
    this.total = value;
    this.title = "callback";
  }
  function receive(inout this, value: i32): i32 as "receive:" {
    if (native.z_subclass_entry_scenario() == 3) {
      return native.z_subclass_call_entry(this, value);
    }
    this.total = this.total + value;
    return this.total;
  }
  function read(in object: native.ZSubclassFixture): i32 as "readFrom:" {
    return object.value();
  }
  function titleSize(): usize as "titleSize" { return this.title.byteLength; }
}

function exercise(): i32 on thread.main {
  let receiver = new Receiver(40);
  if (native.z_subclass_entry_scenario() == 4) native.z_subclass_entry_on_worker(receiver);
  if (native.z_subclass_call_entry(receiver, 1) != 41) return 1;
  if (receiver.receive(1) != 42) return 2;
  if (receiver.read(in receiver) != 40) return 3;
  if (receiver.titleSize() != 8) return 4;
  return 0;
}

function main(): i32 {
  native.z_subclass_catch_abort();
  let count = 0;
  while (count < 200) {
    const result = exercise();
    if (result != 0) return result;
    count = count + 1;
  }
  if (native.z_subclass_live_count() != 0) return 5;
  return 0;
}
