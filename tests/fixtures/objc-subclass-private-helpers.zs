import native from "./objc-subclass.h";
import { thread } from "std/thread";

class Observer on thread.main {
  owner: native.ZSubclassFixture | null;
  value: i32;
  deinit { native.z_subclass_leave_body(); }
}

class WindowState extends native.ZSubclassFixture on thread.main {
  private observer: Option<Weak<Observer>>;
  private count: i32;

  constructor(value: i32) {
    super.initWithValue(value);
    this.observer = Option.none;
    this.count = 0;
  }

  // These are ordinary private Z functions, never Objective-C selectors.
  private function currentObserver(): Option<Observer> {
    return match (in this.observer) {
      some(handle) => match (attempt handle.upgrade()) {
        success(value) => Option.some(value);
        failure(_) => Option.none;
      }
      none => Option.none;
    };
  }

  private function observedValue(): i32 {
    const found = this.currentObserver();
    return match (found) { some(observer) => observer.value; none => -1; };
  }

  private function update(inout this, value: i32): i32 {
    this.count = value;
    if (value == 99) return native.z_subclass_call_read(this, 0);
    if (value == 98) {
      const cleanup = native.z_subclass_access_cleanup(this, 0);
      cleanup.touch();
      return 0;
    }
    return this.observedValue();
  }

  private function updateOther(inout this, other: WindowState): i32 {
    return other.update(7);
  }

  private function readOther(other: WindowState): i32 {
    return other.observedValue();
  }

  override function readAccess(mode: i32): i32 as "readAccess:" {
    return this.observedValue();
  }

  override function writeAccess(inout this, mode: i32): i32 as "writeAccess:" {
    if (mode == 1) return this.update(99);
    if (mode == 2) return this.update(98);
    // A parameter can alias this window without spelling `this` in the helper.
    // It must acquire/check its own loan, not inherit one by object identity.
    if (mode == 3) return this.readOther(this);
    native.z_subclass_enter_body();
    const observer = new Observer({ owner: this, value: 42 });
    this.observer = Option.some(weak observer);
    if (this.update(42) != 42) return -2;
    // A different receiver acquires its own access, not this entry's loan.
    const other = new WindowState(0);
    if (this.updateOther(other) != -1) return -3;
    return this.count;
  }
}

function exercise(): i32 on thread.main {
  const window = new WindowState(0);
  const scenario = native.z_subclass_access_scenario();
  if (scenario != 0) return window.writeAccess(scenario);
  if (window.readAccess(0) != -1) return 1;
  if (window.writeAccess(0) != 42) return 2;
  if (window.readAccess(0) != -1) return 3;
  return 0;
}

function main(): i32 {
  native.z_subclass_catch_abort();
  let index: i32 = 0;
  while (index < 200) {
    const result = exercise();
    if (result != 0) return result;
    if (native.z_subclass_live_count() != 0) return 4;
    if (native.z_subclass_body_balance() != 0) return 5;
    index = index + 1;
  }
  return 0;
}
