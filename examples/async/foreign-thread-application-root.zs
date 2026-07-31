import console from "std/console";
import { TaskControl, TaskScope } from "std/async";
import { Mutex, Once, OnceLifetime } from "std/sync";
import { thread } from "std/thread";
import native from "../interop/c/cross-thread-callback/native-callback.h";

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
    console.log(`foreign callback published ${value} on main`);
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

function beginCalculation(updates: TaskScope): void {
  native.z_example_start_calculation(
    42,
    move (value: i32): i32 => {
      // The generated thread-any adapter enters the captured Z runtime before
      // this body retrieves or releases the mixed-affinity ARC identity.
      const current = currentApplication();
      current.record(value);

      const control: TaskControl = updates.schedule(
        thread.main,
        move (): void => {
          const mainApplication = currentApplication();
          mainApplication.publish(value);
        }
      );
      return control.accepted ? value : -1;
    }
  );
}

async function main(): i32 on thread.main {
  const value = new Application({
    state: Mutex(ApplicationState({ observed: 0 })),
    published: 0,
  });
  const lifetime = initializeApplication(value);

  async scope updates {
    beginCalculation(updates);
    const result = native.z_example_join_calculation();
    if (result != 42) return 1;
  }

  const current = currentApplication();
  return current.observed() + current.published - 84;
}
