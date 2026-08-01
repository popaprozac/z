import { Mutex } from "std/sync";

struct RuntimeState {
  completed: i32;
}

class Application {
  readonly state: Mutex<RuntimeState>;
}

function main(): i32 {
  const application = new Application({
    state: Mutex(RuntimeState({ completed: 42 })),
  });
  return 0;
}
