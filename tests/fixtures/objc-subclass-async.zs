import native from "./objc-subclass.h";
import objc from "std/objc";
import { thread } from "std/thread";
import { delay } from "std/time";
import { TaskScope } from "std/async";

class AsyncCounter extends native.ZSubclassFixture on thread.main {
  private total: i32;
  private label: String;
  private pending: native.ZSubclassStoredResource | null;
  constructor(value: i32) {
    super.initWithValue(value);
    this.total = value;
    this.label = "counter";
    this.pending = native.z_subclass_stored_resource(1);
  }
  override function value(): i32 as "value" { return this.total; }
  override function writeAccess(inout this, value: i32): i32 as "writeAccess:" {
    this.total = this.total + value;
    this.pending = null;
    return this.total;
  }
  override function forward(inout this, in sender: objc.Object | null, value: i32): i32 as "delegatedObject:increment:" {
    return super.delegatedObject(sender, increment: value);
  }
}

struct CounterOwner {
  counter: AsyncCounter;
}

async function delayedWrapped(): i32 on thread.main {
  const owner = CounterOwner({ counter: new AsyncCounter(42) });
  await delay(1);
  return owner.counter.value() - 42;
}

async function observe(counter: AsyncCounter): i32 on thread.main {
  await delay(1);
  return counter.value();
}

async function delayedLocal(): i32 on thread.main {
  const counter = new AsyncCounter(40);
  await delay(1);
  if (counter.forward(null, 2) != 42) return 1;
  return 0;
}

async function exercise(): i32 on thread.main {
  const counter = new AsyncCounter(42);
  const result = await observe(counter);
  if (result != 42) return 2;
  return 0;
}

async function linger(): void on thread.main {
  const counter = new AsyncCounter(7);
  await delay(1000);
  const value = counter.value();
}

async function hold(counter: AsyncCounter): void on thread.main {
  await delay(1000);
  const value = counter.value();
}

async function cancelBeforePoll(): i32 on thread.main {
  const updates = new TaskScope();
  const counter = new AsyncCounter(42);
  const control = updates.schedule(thread.main, async move (): void => await hold(counter));
  const requested = control.requestCancel();
  await updates.close();
  return control.accepted && requested ? 0 : 11;
}

async function failOwned(): i32 throws i32 on thread.main {
  const counter = new AsyncCounter(9);
  await delay(1);
  throw counter.value();
}

async function main(): i32 on thread.main {
  native.z_subclass_catch_abort();
  const wrapped = await delayedWrapped();
  if (wrapped != 0) return wrapped;
  const delayed = await delayedLocal();
  if (delayed != 0) return delayed;
  const result = await exercise();
  if (result != 0) return result;
  if (native.z_subclass_live_count() != 0 || native.z_subclass_stored_live() != 0) return 3;
  const updates = new TaskScope();
  const pending = updates.schedule(thread.main, async move (): void => await linger());
  const interleaved = await observe(new AsyncCounter(42));
  if (interleaved != 42) return 10;
  if (native.z_subclass_live_count() != 1) return 4;
  const requested = pending.requestCancel();
  await updates.close();
  if (!pending.accepted || !requested) return 11;
  if (native.z_subclass_live_count() != 0 || native.z_subclass_stored_live() != 0) return 5;
  const cancelled = await cancelBeforePoll();
  if (cancelled != 0) return cancelled;
  if (native.z_subclass_live_count() != 0 || native.z_subclass_stored_live() != 0) return 6;
  const failed = attempt await failOwned();
  const failureValue = match (failed) { success(value) => -1; failure(value) => value; };
  if (failureValue != 9) return 12;
  if (native.z_subclass_live_count() != 0 || native.z_subclass_stored_live() != 0) return 7;
  if (native.z_subclass_stored_created() != 7 || native.z_subclass_stored_destroyed() != 7) return 8;
  if (native.z_subclass_lifecycle_failures() != 0) return 9;
  return 0;
}
