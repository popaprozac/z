import console from "std/console";

export class Cell<T> {
  value: T;
  marker: i32;

  function replace(inout this, value: T): void {
    this.value = value;
  }

  deinit {
    console.log(`module drop ${this.marker}`);
  }
}
