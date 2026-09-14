import console from "std/console";
export class ObservedItem {
  value: i32;
  deinit { console.log("released observed item"); }
}
