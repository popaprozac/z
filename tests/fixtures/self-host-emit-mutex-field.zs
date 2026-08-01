import { Mutex, Once, OnceLifetime } from "std/sync";
import { thread } from "std/thread";

struct RuntimeState {
  completed: i32;
}

class Application on thread.main {
  readonly state: Mutex<RuntimeState>;

  function answer(): i32 {
    return this.state.withLock(
      (in value): i32 => value.completed
    );
  }

}

const application = Once<Application>();

function install(value: Application): OnceLifetime<Application> on thread.main {
  return application.initialize(move value);
}

function current(): Application {
  return application.get();
}

function main(): i32 on thread.main {
  const lifetime = install(new Application({
    state: Mutex(RuntimeState({ completed: 42 })),
  }));
  const installed = current();
  return installed.answer() - 42;
}
