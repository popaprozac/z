import console from "std/console";

class Cell<T> {
  value: T;
  marker: i32;

  deinit {
    console.log(`private drop ${this.marker}`);
  }
}

export function privateStatus(): i32 {
  const cell = new Cell<i32>({ value: 42, marker: 7 });
  const shared = cell;
  return shared.value - cell.value;
}
