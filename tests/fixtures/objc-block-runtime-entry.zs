import { TaskControl, TaskScope } from "std/async";
import { Mutex, Once, OnceLifetime } from "std/sync";
import { thread } from "std/thread";
import Native from "objc-blocks.h";

struct ApplicationState {
  observed: i32;
}

class Application {
  readonly state: Mutex<ApplicationState>;
  published: i32 on thread.main;

  function record(value: i32): void {
    this.state.withLock((inout state): void => {
      state.observed = value;
    });
  }

  function observed(): i32 {
    return this.state.withLock(
      (in state): i32 => state.observed
    );
  }

  function publish(inout this, value: i32): void on thread.main {
    this.published = value;
  }
}

const application = Once<Application>();

function initializeApplication(
  value: Application
): OnceLifetime<Application> on thread.main {
  return application.initialize(move value);
}

function currentApplication(): Application {
  return application.get();
}

function observeNativeCallback(updates: TaskScope): void {
  Native.ZObjCBlockFixture.invokeOnWorker(move (value) => {
    const current = currentApplication();
    current.record(value);

    const control: TaskControl = updates.schedule(
      thread.main,
      move (): void => {
        const mainApplication = currentApplication();
        mainApplication.publish(value);
      }
    );
    if (!control.accepted) {
      return;
    }
  });
}

async function main(): i32 on thread.main {
  const value = new Application({
    state: Mutex(ApplicationState({ observed: 0 })),
    published: 0,
  });
  const lifetime = initializeApplication(value);

  async scope updates {
    observeNativeCallback(updates);
  }

  const current = currentApplication();
  return current.observed() + current.published - 84;
}
