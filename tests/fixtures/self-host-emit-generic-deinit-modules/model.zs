import console from "std/console";

export struct Receipt<T> {
  value: T;
  marker: i32;

  deinit {
    console.log(`module drop ${this.marker}`);
  }
}
