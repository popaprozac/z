import console from "std/console";

struct Item {
  id: i32;
  deinit { console.log(`released ${this.id}`); }
}

function main(): i32 {
  let empty = Array<u8>.withCapacity(0);
  if (empty.length != 0 || empty.capacity != 0) return 1;
  empty.reserveCapacity(0);
  let bytes = Array<u8>.withCapacity(1024);
  if (bytes.length != 0 || bytes.capacity < 1024) return 2;
  const capacity = bytes.capacity;
  let index: usize = 0;
  while (index < 1024) {
    bytes.push(65);
    if (bytes.capacity != capacity) return 3;
    index = index + 1;
  }
  bytes.reserveCapacity(8);
  if (bytes.length != 1024 || bytes.capacity != capacity) return 4;
  bytes.reserveCapacity(4096);
  if (bytes.length != 1024 || bytes.capacity < 4096 || bytes[1023] != 65) return 5;
  let items = Array<Item>.withCapacity(2);
  items.push(Item({ id: 1 }));
  items.push(Item({ id: 2 }));
  items.reserveCapacity(64);
  if (items.length != 2 || items[0].id != 1 || items[1].id != 2) return 6;
  items.clear();
  if (items.length != 0 || items.capacity < 64) return 7;
  return 0;
}
