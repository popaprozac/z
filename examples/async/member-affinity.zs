import { Mutex } from "std/sync";
import { thread } from "std/thread";

struct ApplicationState {
  revision: i32;
}

// The native/UI-shaped field controls lifecycle placement without making the
// synchronized state or readonly metadata inaccessible to workers.
class Application {
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

async function main(): i32 on thread.main {
  const application = new Application({
    name: "Z desktop",
    state: Mutex(ApplicationState({ revision: 42 })),
    windowId: 7
  });

  // `move` marks the native-thread capture. ARC retains Application and the
  // Mutex handle shares its protected cell, so the parent reference survives.
  const worker = thread.spawn(
    move (): i32 => application.revision()
  );

  const revision = await worker;
  return revision - application.currentWindowId() - 35;
}
