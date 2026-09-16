import { scheduler } from "std/async";
import console from "std/console";

class Item {
  id: i32;
  deinit { console.log(`released ${this.id}`); }
}

async function main(): i32 {
  let items = Array<Item>.withCapacity(1);
  items.push(new Item({ id: 42 }));
  await scheduler.yield();
  items.reserveCapacity(16);
  if (items.length != 1 || items.capacity < 16 || items[0].id != 42) return 1;
  await scheduler.yield();
  items.clear();
  return 0;
}
