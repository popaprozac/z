import { Mutex, Once, OnceLifetime } from "std/sync";
import { thread } from "std/thread";

struct RuntimeState {
  completed: i32;
}

class Snapshot {
  value: i32;
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
      const selected = Option.some(completed);
      match (selected) {
        some(next) => value.completed = next;
        none => value.completed = 0;
      }
    });
  }

  function answerPlus(offset: i32): i32 {
    return this.state.withLock(
      (in value): i32 => value.completed + offset
    );
  }

  function snapshot(): i32 {
    return this.state.withLock((in value): i32 => {
      const snapshot = new Snapshot({ value: value.completed });
      return snapshot.value;
    });
  }

  function verifySnapshot(inout this): void {
    const observed = this.state.withLock((in value): boolean => {
      const snapshot = new Snapshot({ value: value.completed });
      return snapshot.value == value.completed;
    });
    if (!observed) this.status = -1;
  }

  function answerWithStatus(other: Application): i32 {
    return this.state.withLock(
      (in value): i32 => value.completed + other.status
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
  installed.verifySnapshot();
  return installed.answerPlus(1) - 45
    + installed.answerWithStatus(installed) - 51
    + installed.snapshot() - 44
    + installed.status - 7;
}
