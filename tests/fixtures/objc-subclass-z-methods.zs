import native from "./objc-subclass.h";
import { thread } from "std/thread";

export class Observer on thread.main {
  owner: native.ZSubclassFixture;
  value: i32;
  deinit { native.z_subclass_leave_body(); }
}

export class WindowState extends native.ZSubclassFixture on thread.main {
  private observer: Option<Weak<Observer>>;

  constructor(value: i32) {
    super.initWithValue(value);
    this.observer = Option.none;
  }

  // Z-only public methods: no selector or native representation for Weak<T>.
  function observe(inout this, observer: Weak<Observer>): void {
    this.observer = Option.some(observer);
  }

  function snapshot(): Option<Observer> {
    return this.currentObserver();
  }

  function clear(inout this): void {
    this.observer = Option.none;
  }

  function observedValue(): i32 {
    return match (this.currentObserver()) {
      some(observer) => observer.value;
      none => -1;
    };
  }

  function guardedWrite(inout this, mode: i32): i32 {
    if (mode == 1) return native.z_subclass_call_read(this, 0);
    if (mode == 2) {
      const cleanup = native.z_subclass_access_cleanup(this, 0);
      cleanup.touch();
      return 0;
    }
    // Alias calls still acquire a distinct loan, even through public methods.
    if (mode == 3) return this.readOther(this);
    return this.observedValue();
  }

  private function readOther(other: WindowState): i32 {
    return other.observedValue();
  }

  private function currentObserver(): Option<Observer> {
    return match (in this.observer) {
      some(handle) => match (attempt handle.upgrade()) {
        success(value) => Option.some(value);
        failure(_) => Option.none;
      }
      none => Option.none;
    };
  }

  override function readAccess(mode: i32): i32 as "readAccess:" {
    return this.observedValue();
  }
}

function install(window: WindowState): i32 on thread.main {
  native.z_subclass_enter_body();
  const observer = new Observer({ owner: window, value: 42 });
  window.observe(weak observer);
  window.observe(weak observer); // replacement releases the previous weak handle
  if (window.guardedWrite(0) != 42) return 1;
  const snapshot = window.snapshot();
  return match (snapshot) {
    some(value) => value.value == 42 ? 0 : 2;
    none => 3;
  };
}

function exercise(): i32 on thread.main {
  const window = new WindowState(0);
  const scenario = native.z_subclass_access_scenario();
  if (scenario != 0) return window.guardedWrite(scenario);
  if (window.observedValue() != -1) return 4;
  const result = install(window);
  if (result != 0) return result;
  // The external owner has gone away; the window did not retain it.
  if (window.observedValue() != -1) return 5;
  window.clear();
  if (window.observedValue() != -1) return 6;
  return 0;
}

function main(): i32 {
  native.z_subclass_catch_abort();
  let index: i32 = 0;
  while (index < 200) {
    const result = exercise();
    if (result != 0) return result;
    if (native.z_subclass_live_count() != 0) return 7;
    if (native.z_subclass_body_balance() != 0) return 8;
    index = index + 1;
  }
  return 0;
}
