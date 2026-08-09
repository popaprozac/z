import { delay } from "std/time";

enum Mode {
  active i32,
  idle,
}

async function inspect(in mode: Mode): i32 {
  return match (in mode) {
    active(value) => {
      await delay(1);
      select value;
    }
    idle => 0;
  };
}
