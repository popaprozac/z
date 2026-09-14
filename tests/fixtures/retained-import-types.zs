import console from "std/console";

export class Item {
  readonly value: i32;
  deinit { console.log("released imported item"); }
}

export type Callback = () => i32;
