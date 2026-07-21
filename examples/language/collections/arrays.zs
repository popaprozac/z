import stdio from "stdio.h";

struct Item {
  value: i32;

  deinit {
    stdio.printf("drop=%d\n", this.value);
  }
}

struct ItemCollection {
  items: Item[3];
}

function sum(in values: i32[4]): i32 {
  let index: usize = 0;
  let total = 0;
  while (index < values.length) {
    total = total + values[index];
    index = index + 1;
  }
  return total;
}

function main(): i32 {
  let values: i32[4] = [10, 20, 30, 40];
  values[2] = 42;
  stdio.printf("length=%zu sum=%d\n", values.length, sum(values));

  const collection = ItemCollection({ items: [Item({ value: 1 }), Item({ value: 2 }), Item({ value: 3 })] });
  stdio.printf("middle=%d\n", collection.items[1].value);
  return 0;
}
