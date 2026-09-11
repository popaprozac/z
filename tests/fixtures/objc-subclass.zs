import native from "./objc-subclass.h";
import { thread } from "std/thread";

type ReadValue = () => i32 on thread.main;

function storedTitle(): String {
  const source = "first second";
  return source.copyBytes(0, 5);
}

struct BodyResource {
  text: String;
  deinit { native.z_subclass_leave_body(); }
}

class Counter extends native.ZSubclassFixture on thread.main {
  private offset: i32;
  private title: String;
  private point: native.ZSubclassPoint;
  constructor(value: i32) {
    super.initWithValue(value);
    this.offset = 2;
    this.title = storedTitle();
    this.point = native.ZSubclassPoint({ x: 1, y: 2 });
    const cleanup: native.ZSubclassConstructorCleanup = native.z_subclass_constructor_cleanup(this);
    const configuration = (): i32 => {
      const initial = (): i32 => { return 1; };
      return initial();
    };
    this.configuredValue = configuration();
    native.z_subclass_check_constructing(this);
    cleanup.touch();
  }

  override function value(): i32 as "value" {
    native.z_subclass_enter_body();
    const source = "first second";
    const resource = BodyResource({ text: source.copyBytes(0, 5) });
    const length = (): usize => resource.text.byteLength;
    if (length() != 5) return -1;
    if (this.title.byteLength != 5) return -2;
    return super.value() + this.offset;
  }

  override function sum(left: i32, right: i32): i32 as "add:to:" {
    return super.add(left, to: right) + 1;
  }

  override function read(in object: native.ZSubclassFixture): i32 as "readObject:" {
    const callback: ReadValue = move (): i32 => object.value();
    return callback();
  }

  override function record(inout this, phase: i32): void as "recordPhase:" {
    this.title = storedTitle();
    this.offset = 2;
    super.recordPhase(phase + 10);
  }

  override function adjust(point: native.ZSubclassPoint): native.ZSubclassPoint as "adjustPoint:" {
    return native.ZSubclassPoint({ x: point.x + this.point.x, y: point.y + this.point.y });
  }

  override function readAccess(mode: i32): i32 as "readAccess:" {
    if (mode == 1) return native.z_subclass_call_write(this, 0);
    if (mode == 2 || mode == 3) {
      const cleanup: native.ZSubclassAccessCleanup = native.z_subclass_access_cleanup(this, mode == 2 ? 1 : 0);
      cleanup.touch();
      return 0;
    }
    // Reentrant shared access remains legal.
    if (mode == 4) return native.z_subclass_call_read(this, 0);
    return super.readAccess(mode);
  }

  override function writeAccess(inout this, mode: i32): i32 as "writeAccess:" {
    if (mode == 1) return native.z_subclass_call_read(this, 0);
    if (mode == 2) return native.z_subclass_call_write(this, 0);
    if (mode == 3) {
      native.z_subclass_drop_published();
      return native.z_subclass_live_count();
    }
    if (mode == 4) {
      const cleanup: native.ZSubclassAccessCleanup = native.z_subclass_access_cleanup(this, 0);
      cleanup.touch();
      return 0;
    }
    if (mode == 5) {
      const other = new Counter(1);
      return native.z_subclass_call_read(other, 0);
    }
    return super.writeAccess(mode);
  }

  deinit {
    const observed = copy this.title;
    native.z_subclass_source_deinit(observed.byteLength, this.offset);
  }
}

function publishCounter(): void on thread.main {
  const counter = new Counter(40);
  native.z_subclass_publish(counter);
}

function exerciseAccess(scenario: i32): i32 on thread.main {
  const counter = new Counter(40);
  if (scenario == 1) return native.z_subclass_call_read(counter, 1);
  if (scenario == 2) return native.z_subclass_call_write(counter, 1);
  if (scenario == 3) return native.z_subclass_call_write(counter, 2);
  if (scenario == 4) return native.z_subclass_call_read(counter, 2);
  if (scenario == 5) return native.z_subclass_call_write(counter, 4);
  if (native.z_subclass_call_read(counter, 4) != 0) return 10;
  if (native.z_subclass_call_read(counter, 3) != 0) return 11;
  if (native.z_subclass_call_write(counter, 0) != 0) return 12;
  if (native.z_subclass_call_write(counter, 0) != 0) return 13;
  if (native.z_subclass_call_write(counter, 5) != 0) return 14;
  return native.z_subclass_call_read(counter, 0);
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
  counter.record(4);
  if (counter.recordedPhase != 14) return 4;
  const point = counter.adjust(native.ZSubclassPoint({ x: 1, y: 2 }));
  if (point.x != 2 || point.y != 4) return 5;
  return base.readVirtualValue() + counter.sum(20, to: 21) + counter.configuredValue
    + counter.read(in base) - 127;
}

function main(): i32 {
  native.z_subclass_catch_abort();
  if (exerciseAccess(native.z_subclass_access_scenario()) != 0) return 10;
  publishCounter();
  if (native.z_subclass_call_published() != 1) return 11;
  if (native.z_subclass_live_count() != 0) return 12;
  let index: i32 = 0;
  while (index < 200) {
    if (exercise() != 0) return 1;
    if (exerciseEscapingReader() != 0) return 2;
    if (native.z_subclass_body_balance() != 0) return 3;
    index = index + 1;
  }
  if (native.z_subclass_construction_callbacks() != 403) return 6;
  if (native.z_subclass_teardown_callbacks() != 403) return 7;
  if (native.z_subclass_constructor_cleanups() != 403) return 8;
  if (native.z_subclass_source_deinits() != 403) return 15;
  if (native.z_subclass_lifecycle_failures() != 0) return 9;
  return native.z_subclass_live_count();
}
