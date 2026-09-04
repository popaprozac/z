import { thread } from "std/thread";

export class Item on thread.main {
  value: i32;

  internal function read(): i32 {
    return this.value;
  }
}
