import { Mutex } from "std/sync";
import console from "std/console";

class Item {
  readonly label: i32;
  deinit { console.log(`released item ${this.label}`); }
}
struct Store { items: Array<Option<Item>>; }
struct Receipt {
  label: String;
  deinit { console.log(`released ${this.label}`); }
}
struct Row { values: Array<Receipt>; }
struct Failure { message: String; }

function expired(in watch: Weak<Item>): boolean {
  return match (attempt watch.upgrade()) {
    success(item) => false;
    failure(error) => true;
  };
}

function registered(in store: Mutex<Store>): Weak<Item> {
  // Construction inside the callback isolates indexed replacement from
  // borrowed capture setup in the other regression fixture.
  return store.withLock((inout state): Weak<Item> => {
    const item = new Item({ label: 1 });
    state.items.push(Option<Item>.some(item));
    return weak item;
  });
}

function capturedInsertRemove(in store: Mutex<Store>): Weak<Item> {
  const item = new Item({ label: 4 });
  const watch = weak item;
  store.withLock((inout state): void => {
    state.items.push(Option<Item>.some(item));
  });
  store.withLock((inout state): void => {
    state.items[1] = Option<Item>.none;
  });
  // Only the weak handle may remain after this helper's local owner exits.
  return watch;
}

function selectedIndex(): usize { console.log("index"); return 0; }
function selectedRow(): usize { console.log("row"); return 0; }
function replacement(in label: String): Receipt {
  console.log("value");
  return Receipt({ label: copy label });
}
function reject(): Receipt throws Failure {
  console.log("reject");
  throw Failure({ message: "failed replacement" });
}
function fail(inout values: Array<Receipt>): void throws Failure {
  values[selectedIndex()] = try reject();
}

function main(): i32 {
  const store = Mutex(Store({ items: Array<Option<Item>>() }));
  const watch = registered(in store);
  if (expired(in watch)) return 1;
  store.withLock((inout state): void => {
    state.items[selectedIndex()] = Option<Item>.none;
  });
  if (!expired(in watch)) return 2;
  // Replacing an empty slot does not run the old payload's cleanup again.
  store.withLock((inout state): void => { state.items[0] = Option<Item>.none; });

  {
    let values = Array<Receipt>(Receipt({ label: "old" }));
    values[selectedIndex()] = replacement("new");
    if (values[0].label != "new") return 3;
    match (attempt fail(inout values)) {
      success => return 4;
      failure(error) => { if (error.message != "failed replacement") return 5; }
    }
    if (values[0].label != "new") return 6;
  }
  {
    let rows = Array<Row>(Row({ values: Array<Receipt>(Receipt({ label: "nested old" })) }));
    rows[selectedRow()].values[selectedIndex()] = replacement("nested new");
    if (rows[0].values[0].label != "nested new") return 7;
  }
  {
    let items = Array<Item>(new Item({ label: 2 }));
    const observer = weak items[0];
    items[selectedIndex()] = items[0];
    if (expired(in observer)) return 8;
    items[selectedIndex()] = new Item({ label: 3 });
    if (!expired(in observer)) return 9;
  }
  {
    const source = "before after";
    let values = Array<String>(source.copyBytes(0, 6));
    values[selectedIndex()] = source.copyBytes(7, 12);
    if (values[0] != "after") return 10;
  }
  {
    let values: Receipt[1] = [Receipt({ label: "fixed old" })];
    values[selectedIndex()] = replacement("fixed new");
    if (values[0].label != "fixed new") return 11;
  }
  const captured = capturedInsertRemove(in store);
  if (!expired(in captured)) return 12;
  return 0;
}
