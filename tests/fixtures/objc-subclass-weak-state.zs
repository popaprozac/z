import native from "./objc-subclass.h";
import { thread } from "std/thread";

class Observer on thread.main {
  owner: native.ZSubclassFixture | null;
  value: i32;
  deinit { native.z_subclass_leave_body(); }
}

function expiredObserver(): Weak<Observer> on thread.main {
  native.z_subclass_enter_body();
  const observer = new Observer({ owner: null, value: 0 });
  return weak observer;
}

class WindowState extends native.ZSubclassFixture on thread.main {
  private observer: Option<Weak<Observer>>;
  private previous: Weak<Observer>;

  constructor(value: i32) {
    super.initWithValue(value);
    this.observer = Option.none;
    this.previous = expiredObserver();
  }

  override function readAccess(mode: i32): i32 as "readAccess:" {
    return match (in this.observer) {
      some(handle) => match (attempt handle.upgrade()) {
        success(value) => value.value;
        failure(_) => -1;
      }
      none => 0;
    };
  }

  override function writeAccess(inout this, mode: i32): i32 as "writeAccess:" {
    native.z_subclass_enter_body();
    // Strong observer -> window, weak window -> observer: no cycle.
    const observer = new Observer({ owner: this, value: 42 });
    this.observer = Option.some(weak observer);
    this.previous = weak observer;
    const snapshot = this.previous;
    this.observer = Option.none;
    const observed = match (attempt snapshot.upgrade()) {
      success(value) => value.value;
      failure(_) => -1;
    };
    this.previous = expiredObserver();
    this.observer = Option.some(snapshot);
    return observed;
  }
}

function exercise(): i32 on thread.main {
  const window = new WindowState(0);
  if (window.readAccess(0) != 0) return 1;
  if (window.writeAccess(0) != 42) return 2;
  if (window.readAccess(0) != -1) return 3;
  return 0;
}

type LaterObservation = () => i32 on thread.main;

function laterObservation(): LaterObservation on thread.main {
  const window = new WindowState(0);
  native.z_subclass_enter_body();
  const observer = new Observer({ owner: window, value: 42 });
  const handle = weak observer;
  return move (): i32 => {
    return match (attempt handle.upgrade()) {
      success(value) => value.value;
      failure(_) => -1;
    };
  };
}

function main(): i32 {
  let index: i32 = 0;
  while (index < 200) {
    const result = exercise();
    if (result != 0) return result;
    if (native.z_subclass_live_count() != 0) return 4;
    if (native.z_subclass_body_balance() != 0) return 5;
    const callback = laterObservation();
    if (native.z_subclass_live_count() != 0) return 6;
    if (callback() != -1) return 7;
    if (native.z_subclass_body_balance() != 0) return 8;
    index = index + 1;
  }
  return 0;
}
