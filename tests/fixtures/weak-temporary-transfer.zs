import console from "std/console";

class Item {
  value: i32;
  deinit { console.log("released item"); }
}

function take(reference: Weak<Item>): i32 {
  return match (attempt reference.upgrade()) {
    success(item) => item.value;
    failure(_) => -1;
  };
}

function read(in reference: Weak<Item>): i32 {
  return match (attempt reference.upgrade()) {
    success(item) => item.value;
    failure(_) => -1;
  };
}

function relay(value: i32): i32 { return value; }
function forward(reference: Weak<Item>): Weak<Item> { return reference; }
function retained(reference: Weak<Item>): () => i32 {
  return move (): i32 => take(reference);
}

function takeOptional(reference: Option<Weak<Item>>): i32 {
  return match (in reference) {
    some(observer) => take(observer);
    none => -1;
  };
}

function takeNested(reference: Option<Option<Weak<Item>>>): i32 {
  return match (in reference) {
    some(observer) => { select match (in observer) { some(value) => read(value); none => -1; }; }
    none => -2;
  };
}

function main(): i32 {
  const item = new Item({ value: 42 });
  const transferred = relay(take(weak item));
  if (transferred != 42) return 1;
  if (relay(take(weak item)) != 42) return 2;
  const callback = retained(weak item);
  if (callback() != 42 || callback() != 42) return 3;
  const named = weak item;
  if (take(named) != 42 || read(named) != 42) return 4;
  const returned = forward(weak item);
  if (take(returned) != 42 || read(returned) != 42) return 5;
  if (takeOptional(Option.some(weak item)) != 42) return 6;
  if (takeOptional(Option.some(named)) != 42) return 7;
  if (takeNested(Option.some(Option.some(weak item))) != 42) return 8;
  return 0;
}
