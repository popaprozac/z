import console from "std/console";

export class Cell<T> {
  value: T;
  marker: i32;

  deinit {
    console.log(`released module cell ${this.marker}`);
  }
}
