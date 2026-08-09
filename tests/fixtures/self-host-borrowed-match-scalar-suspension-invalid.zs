import { delay } from "std/time";

enum Mode {
  active i32,
  idle,
}

async function inspect(in mode: Mode): i32 {
  match (in mode) {
    active(value) => {
      await delay(1);
      return value;
    }
    idle => return 0;
  }
}
