import console from "std/console";

class Cell<T> {
  value: T;
  marker: i32;

  constructor(value: T, marker: i32) {
    this.value = value;
    this.marker = marker;
  }

  function replace(inout this, value: T): void {
    this.value = value;
  }

  deinit {
    console.log(`drop ${this.marker}`);
  }
}

function main(): i32 {
  let number = new Cell<i32>(20, 1);
  number.replace(42);
  const sharedNumber = number;
  if (sharedNumber.value != 42 || number.value != 42) return 1;

  let words = new Cell<String>("first", 2);
  words.replace("owned");
  const sharedWords = words;
  if (sharedWords.value != "owned" || words.value != "owned") return 2;
  return 0;
}
