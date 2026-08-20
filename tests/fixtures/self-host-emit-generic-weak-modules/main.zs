import { Cell as SharedCell } from "./library.zs";

function read(in observer: Weak<SharedCell<i32>>): i32 {
  const upgraded = attempt observer.upgrade();
  return match (upgraded) {
    success(cell) => cell.value;
    failure(expired) => -1;
  };
}

function main(): i32 {
  let current = new SharedCell<i32>({ value: 42, marker: 1 });
  const observer = weak current;
  if (read(observer) != 42) return 1;

  current = new SharedCell<i32>({ value: 7, marker: 2 });
  if (read(observer) != -1) return 2;
  return 0;
}
