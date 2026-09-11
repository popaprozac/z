import native from "./objc-subclass.h";
import objc from "std/objc";
import { thread } from "std/thread";

class HandoffCounter extends native.ZSubclassFixture on thread.main {
  private total: i32;
  private label: String;
  private pending: native.ZSubclassStoredResource | null;
  constructor(value: i32) {
    super.initWithValue(value);
    this.total = value;
    this.label = "counter";
    this.pending = native.z_subclass_stored_resource(1);
  }
  override function writeAccess(inout this, value: i32): i32 as "writeAccess:" {
    this.total = this.total + value;
    this.pending = null;
    if (value == 3) native.z_subclass_drop_published();
    return this.total;
  }
  override function readAccess(mode: i32): i32 as "readAccess:" {
    if (mode == 1) return this.readerDelegate();
    return this.total;
  }
  override function value(): i32 as "value" { return this.total; }
  override function recordPhase(inout this, value: i32): void as "recordPhase:" {
    this.total = this.total + value;
  }
  function update(inout this, value: i32): i32 as "update:" {
    const snapshot = this.pending;
    const before = this.total;
    const after = super.delegatedWrite(value);
    if (snapshot != null) {
      if (snapshot.value() != 1) return -1;
    }
    if (after != before + value || this.total != after) return -2;
    super.delegatedPhase(1);
    return this.total;
  }
  function readerDelegate(): i32 as "readerDelegate" {
    return super.delegatedWrite(1);
  }
  function conditionalDelegate(inout this, value: i32): i32 as "conditionalDelegate:" {
    if (value > 0) return super.delegatedWrite(value);
    return this.total;
  }
  function releaseDuringHandoff(inout this): i32 as "releaseDuringHandoff" {
    const value = super.delegatedWrite(3);
    return native.z_subclass_live_count();
  }
  function afterHandoff(inout this): i32 as "afterHandoff" {
    const result = super.delegatedWrite(1);
    return native.z_subclass_call_read(this, 0);
  }
  function argumentHandoff(inout this): i32 as "argumentHandoff" {
    return super.delegatedWrite(native.z_subclass_call_read(this, 0));
  }
  function cleanupHandoff(inout this): i32 as "cleanupHandoff" {
    const cleanup: native.ZSubclassAccessCleanup = native.z_subclass_access_cleanup(this, 0);
    cleanup.touch();
    return super.delegatedWrite(1);
  }
  function nestedHandoff(inout this): i32 as "nestedHandoff" {
    return super.delegatedWrite(1) + 0;
  }
  function borrowedArgument(inout this): i32 as "borrowedArgument" {
    return super.readObject(this);
  }
  override function forward(inout this, in sender: objc.Object | null, value: i32): i32 as "delegatedObject:increment:" {
    return super.delegatedObject(sender, increment: value);
  }
  function fieldSnapshot(inout this): i32 as "fieldSnapshot" {
    const before = native.z_subclass_stored_destroyed();
    const result = super.delegatedObject(this.pending, increment: 0);
    if (native.z_subclass_stored_destroyed() != before + 1) return -101;
    return result;
  }
  function senderCleanup(inout this): i32 as "senderCleanup" {
    super.attachResource(this.pending);
    return super.delegatedObject(this.pending, increment: 0);
  }
}

function exercise(): i32 on thread.main {
  const counter = new HandoffCounter(40);
  const scenario = native.z_subclass_access_scenario();
  if (scenario == 1) return counter.afterHandoff();
  if (scenario == 2) return counter.argumentHandoff();
  if (scenario == 3) return counter.cleanupHandoff();
  if (scenario == 4) return counter.readAccess(1);
  if (scenario == 5) return counter.nestedHandoff();
  if (scenario == 6) return counter.borrowedArgument() == 40 ? 0 : 8;
  if (scenario == 7) return counter.senderCleanup();
  if (counter.update(1) != 42) return 1;
  if (counter.readerDelegate() != 43) return 2;
  if (counter.readAccess(0) != 43) return 3;
  if (counter.conditionalDelegate(1) != 44) return 7;
  return objectSnapshots();
}

function objectSnapshots(): i32 on thread.main {
  const counter = new HandoffCounter(40);
  if (counter.fieldSnapshot() != 1) return 9;
  const sender: native.ZSubclassStoredResource = native.z_subclass_stored_resource(7);
  if (counter.forward(sender, 0) != 7) return 10;
  if (counter.forward(null, 0) != 40) return 11;
  // Native code can supply the receiver itself as a borrowed sender. An
  // ordinary Z inout receiver + in argument alias remains statically rejected.
  if (native.z_subclass_call_forward_alias(counter) != 40) return 12;
  return 0;
}

function main(): i32 {
  native.z_subclass_catch_abort();
  let iteration: i32 = 0;
  while (iteration < 200) {
    const result = exercise();
    if (result != 0) return result;
    if (native.z_subclass_live_count() != 0 || native.z_subclass_stored_live() != 0) return 4;
    iteration = iteration + 1;
  }
  publish();
  if (native.z_subclass_call_published_handoff() != 1) return 5;
  if (native.z_subclass_live_count() != 0 || native.z_subclass_stored_live() != 0) return 6;
  return 0;
}

function publish(): void on thread.main {
  const counter = new HandoffCounter(40);
  native.z_subclass_publish(counter);
}
