import { Mutex, Once, OnceLifetime } from "std/sync";
import { thread } from "std/thread";

export struct ApplicationState {
  revision: i32;
}

export class Application {
  readonly name: String;
  readonly state: Mutex<ApplicationState>;
  windowId: i32 on thread.main;

  function revision(): i32 {
    return this.state.withLock(
      (in value): i32 => value.revision
    );
  }

  function currentWindowId(): i32 on thread.main {
    return this.windowId;
  }
}

const application = Once<Application>();

export function initializeApplication(
  value: Application
): OnceLifetime<Application> on thread.main {
  return application.initialize(move value);
}

export function currentApplication(): Application {
  return application.get();
}
