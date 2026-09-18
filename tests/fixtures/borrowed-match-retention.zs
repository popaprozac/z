import { Mutex } from "std/sync";
import console from "std/console";

function destroyed(delta: i32): i32 = raw c {
  static int count = 0;
  count += delta;
  return count;
}
function selectedIndex(delta: i32): usize = raw c {
  static int count = 0;
  count += delta;
  return (size_t)count;
}
struct Tracker {
  value: i32;
  deinit { const count = destroyed(1); }
}
class Item { readonly tracker: Tracker; }
enum Signal { ready, stopped }
function inspectSignal(in signal: Signal): boolean {
  return match (signal) { ready => true; stopped => false; };
}
struct Store {
  slots: Array<Option<Item>>;
  function first(): Option<Item> {
    match (this.slots[0]) {
      some(item) => return Option<Item>.some(item);
      none => return Option<Item>.none;
    }
  }
}

function retainAt(in store: Mutex<Store>, at: usize): Option<Item> {
  return store.withLock((in state): Option<Item> => {
    if (at >= state.slots.length) return Option<Item>.none;
    match (state.slots[at]) {
      some(item) => return Option<Item>.some(item);
      none => return Option<Item>.none;
    }
  });
}
function retainWritable(in store: Mutex<Store>): Option<Item> {
  return store.withLock((inout state): Option<Item> => {
    return match (state.slots[0]) {
      some(item) => Option<Item>.some(item);
      none => Option<Item>.none;
    };
  });
}
function retainDirect(in value: Option<Item>): Option<Item> {
  match (value) {
    some(item) => return Option<Item>.some(item);
    none => return Option<Item>.none;
  }
}
function callBorrowed(in value: Option<Item>, in callback: (in argument: Option<Item>) => Option<Item>): Option<Item> {
  return callback(in value);
}
function retainCallback(in value: Option<Item>): Option<Item> {
  return callBorrowed(in value, (in argument): Option<Item> => {
    return match (argument) {
      some(item) => Option<Item>.some(item);
      none => Option<Item>.none;
    };
  });
}
function retainProjected(in state: Store): Option<Item> {
  // Both the tag and the payload must use the same selected element.
  match (state.slots[selectedIndex(1) - 1]) {
    some(item) => return Option<Item>.some(item);
    none => return Option<Item>.none;
  }
}
function retainThrowing(in store: Mutex<Store>, fail: boolean): Item throws i32 {
  return try store.withLock((in state): Item throws i32 => {
    match (state.slots[0]) {
      some(item) => {
        if (fail) throw 7;
        return item;
      }
      none => throw 8;
    }
  });
}
function value(option: Option<Item>): i32 {
  match (option) {
    some(item) => return item.tracker.value;
    none => return -1;
  }
}
function useThrowing(in store: Mutex<Store>, fail: boolean): i32 {
  return match (attempt retainThrowing(in store, fail)) {
    success(item) => item.tracker.value;
    failure(error) => error;
  };
}

function exercise(): i32 {
  const store = Mutex(Store({ slots: Array<Option<Item>>() }));
  store.withLock((inout state): void => {
    state.slots.push(Option<Item>.some(new Item({ tracker: Tracker({ value: 42 }) })));
    state.slots.push(Option<Item>.none);
  });
  if (value(retainAt(in store, 0)) != 42 || destroyed(0) != 0) return 1;
  if (value(retainAt(in store, 0)) != 42 || destroyed(0) != 0) return 2;
  if (value(retainAt(in store, 1)) != -1) return 3;
  if (value(retainAt(in store, 2)) != -1) return 4;
  if (value(retainWritable(in store)) != 42 || destroyed(0) != 0) return 5;
  const projected = store.withLock((in state): Option<Item> => retainProjected(in state));
  if (selectedIndex(0) != 1 || value(projected) != 42 || destroyed(0) != 0) return 6;
  const directOwner = retainAt(in store, 0);
  const direct = retainDirect(in directOwner);
  if (value(direct) != 42 || destroyed(0) != 0) return 7;
  if (value(retainCallback(in directOwner)) != 42 || destroyed(0) != 0) return 15;
  const method = store.withLock((in state): Option<Item> => state.first());
  if (value(method) != 42 || destroyed(0) != 0) return 8;
  if (useThrowing(in store, false) != 42 || destroyed(0) != 0) return 9;
  if (useThrowing(in store, true) != 7 || destroyed(0) != 0) return 10;
  const retained = retainAt(in store, 0);
  store.withLock((inout state): void => state.slots.clear());
  if (destroyed(0) != 0 || value(retained) != 42) return 11;
  return 0;
}
function consumeOwned(): i32 {
  const option = Option<Item>.some(new Item({ tracker: Tracker({ value: 43 }) }));
  return value(option);
}
struct Nested { slots: Array<Option<Option<Item>>>; }
function retainNested(in nested: Nested): Option<Item> {
  match (nested.slots[0]) {
    some(inner) => {
      match (inner) {
        some(item) => return Option<Item>.some(item);
        none => return Option<Item>.none;
      }
    }
    none => return Option<Item>.none;
  }
}
function exerciseNested(): i32 {
  const nested = Nested({ slots: Array<Option<Option<Item>>>(
    Option<Option<Item>>.some(Option<Item>.some(new Item({ tracker: Tracker({ value: 44 }) })))
  ) });
  if (value(retainNested(in nested)) != 44 || destroyed(0) != 2) return 16;
  if (value(retainNested(in nested)) != 44 || destroyed(0) != 2) return 17;
  return 0;
}
function consumeShadow(in value: Option<Item>): i32 {
  // The owned callback parameter shadows a borrowed enclosing parameter.
  // Borrow status belongs to the binding, not to the spelling "value".
  const callback: (value: Option<Item>) => i32 = (value: Option<Item>): i32 => {
    return match (value) {
      some(item) => item.tracker.value;
      none => -1;
    };
  };
  return callback(Option<Item>.some(new Item({ tracker: Tracker({ value: 45 }) })));
}
function main(): i32 {
  const signal = Signal.ready;
  if (!inspectSignal(in signal)) return 14;
  const status = exercise();
  if (status != 0) return status;
  if (destroyed(0) != 1) return 12;
  if (consumeOwned() != 43 || destroyed(0) != 2) return 13;
  const nestedStatus = exerciseNested();
  if (nestedStatus != 0) return nestedStatus;
  if (destroyed(0) != 3) return 18;
  const absent = Option<Item>.none;
  if (consumeShadow(in absent) != 45 || destroyed(0) != 4) return 19;
  console.log("ok");
  return 0;
}
