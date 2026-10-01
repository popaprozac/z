import console from "std/console";

struct Pair {
  left: u32;
  right: u32;
}

struct Box<T> {
  item: T;

  function get(): T {
    return this.item;
  }
}

// A generic aggregate with no code of its own is data, whatever T is.
struct Bag<T> {
  item: T;
}

function twice<T>(value: T): Array<T> {
  let items = Array<T>();
  items.push(value);
  items.push(value);
  return items;
}

function main(): i32 {
  const numbers = twice(u32(7));
  const pairs = twice(Pair({ left: 1, right: 2 }));
  const box = Box<u32>({ item: 3 });
  const bag = Bag<String>({ item: "kept as data" });
  if (numbers.length != 2 || pairs[1].right != 2 || box.get() != 3 || bag.item.byteLength != 12) return 1;
  console.log("ok");
  return 0;
}
