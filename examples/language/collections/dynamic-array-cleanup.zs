import stdio from "stdio.h";

struct Item {
  id: i32;

  deinit {
    stdio.printf("drop=%d\n", this.id);
  }
}

function main(): i32 {
  const first = Item({ id: 1 });
  const second = Item({ id: 2 });
  const items = Array<Item>(first, second);
  return 0;
}
