import { Item, Callback } from "./retained-import-types.zs";

struct Holder { item: Item; }

function forward(item: Item): Item { return item; }
function invoke(callback: Callback): i32 { return callback(); }

// Deliberately straight-line: conditional live flags must not be needed to
// balance an imported class alias or a shared callable environment.
function exercise(): i32 {
  const item = new Item({ value: 42 });
  const forwarded = forward(item);
  let alias = item;
  alias = forwarded;
  const holder = Holder({ item: alias });
  const callback: Callback = move (): i32 => holder.item.value;
  return invoke(callback) - 42;
}

function main(): i32 {
  return exercise();
}
