import { Mutex } from "std/sync";
import console from "std/console";

class Item {
  readonly label: i32;
  deinit { console.log(`released ${this.label}`); }
}

struct Store { items: Array<Option<Item>>; }

function expired(in watch: Weak<Item>): boolean {
  return match (attempt watch.upgrade()) {
    success(item) => false;
    failure(error) => true;
  };
}

function insert(in store: Mutex<Store>, label: i32): Weak<Item> {
  const item = new Item({ label });
  const watch = weak item;
  store.withLock((inout state): void => state.items.push(Option<Item>.some(item)));
  store.withLock((inout state): void => {
    state.items.push(Option<Item>.some(item));
  });
  return watch;
}

function failing(in store: Mutex<Store>, beforeInsert: boolean): Weak<Item> throws i32 {
  const item = new Item({ label: beforeInsert ? 3 : 2 });
  const watch = weak item;
  const result = attempt store.withLock((inout state): void throws i32 => {
    if (beforeInsert) throw 7;
    state.items.push(Option<Item>.some(item));
    throw 7;
  });
  match (result) {
    success => throw 8;
    failure(error) => { if (error != 7) throw error; }
  }
  store.withLock((inout state): void => state.items.clear());
  return watch;
}

function invoke(in callback: () => void): void { callback(); }
function consume(item: Item): void {
  if (item.label != 4) console.log("wrong item");
}
function ordinary(): Weak<Item> {
  const item = new Item({ label: 4 });
  const watch = weak item;
  invoke((): void => consume(item));
  invoke((): void => { consume(item); });
  return watch;
}

function exercise(): i32 throws i32 {
  const store = Mutex(Store({ items: Array<Option<Item>>() }));
  const stored = insert(in store, 1);
  // Storage must own the references even after insert's local owner exits.
  if (expired(in stored)) return 1;
  store.withLock((inout state): void => state.items.clear());
  if (!expired(in stored)) return 2;
  const afterInsert = try failing(in store, false);
  if (!expired(in afterInsert)) return 3;
  const beforeInsert = try failing(in store, true);
  if (!expired(in beforeInsert)) return 4;
  const called = ordinary();
  if (!expired(in called)) return 5;
  return 0;
}

function main(): i32 {
  return match (attempt exercise()) {
    success(status) => status;
    failure(error) => error;
  };
}
