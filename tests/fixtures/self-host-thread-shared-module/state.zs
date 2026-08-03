import { Mutex } from "std/sync";

export struct Counter {
  value: i32;
}

export readonly class SharedCounter {
  state: Mutex<Counter>;

  function read(): i32 {
    return this.state.withLock(
      (in value): i32 => value.value
    );
  }
}
