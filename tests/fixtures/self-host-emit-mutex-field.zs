import { Mutex, Once, OnceLifetime } from "std/sync";
import { thread } from "std/thread";

struct RuntimeState {
  completed: i32;
}

class Application on thread.main {
  readonly state: Mutex<RuntimeState>;
  status: i32;

  function answer(): i32 {
    return this.state.withLock(
      (in value): i32 => value.completed
    );
  }

  function increment(): i32 {
    return this.state.withLock((inout value): i32 => {
      value.completed = value.completed + 1;
      return value.completed;
    });
  }

  function setCompleted(completed: i32): void {
    this.state.withLock((inout value): void => {
      value.completed = completed;
    });
  }

  function answerPlus(offset: i32): i32 {
    return this.state.withLock(
      (in value): i32 => value.completed + offset
    );
  }

  function publish(inout this, status: i32): void {
    this.status = status;
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
    status: 0,
  }));
  let installed = current();
  installed.setCompleted(44);
  installed.publish(7);
  return installed.answerPlus(1) - 45 + installed.status - 7;
}
