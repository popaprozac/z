import console from "std/console";

struct Receipt<T> {
  value: T;
  marker: i32;

  deinit {
    console.log(`drop ${this.marker}`);
  }
}

function main(): i32 {
  const number = Receipt<i32>({ value: 42, marker: 1 });
  const label = Receipt<String>({ value: "ready", marker: 2 });
  return number.value + i32(label.value.byteLength) - 47;
}
