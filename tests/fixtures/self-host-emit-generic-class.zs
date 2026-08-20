import console from "std/console";

class Cell<T> {
  value: T;
  marker: i32;

  function replace(inout this, value: T): void {
    this.value = value;
  }

  deinit {
    console.log(`drop ${this.marker}`);
  }
}

function main(): i32 {
  let number = new Cell<i32>({ value: 20, marker: 1 });
  number.replace(42);
  const sharedNumber = number;
  if (sharedNumber.value != 42 || number.value != 42) return 1;

  let words = new Cell<String>({ value: "first", marker: 2 });
  words.replace("owned");
  const sharedWords = words;
  if (sharedWords.value != "owned" || words.value != "owned") return 2;
  return 0;
}
