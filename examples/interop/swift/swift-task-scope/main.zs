import console from "std/console";
import { TaskControl, TaskScope } from "std/async";
import { Mutex, Once, OnceLifetime } from "std/sync";
import { thread } from "std/thread";
import { delay } from "std/time";
import AppKit from "AppKit/AppKit.h";
import Swift from "ZSwiftTaskScope-Swift.h";

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
    console.log(`swift callback published ${value} on main`);
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

function observeSwiftCallback(updates: TaskScope): void {
  Swift.ZSwiftBackgroundWorker.calculate(
    40,
    completion: move (value) => {
      // Swift invokes this block on a global Dispatch queue. The generated
      // adapter enters the captured Z runtime for this bounded invocation.
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
        console.error("Swift callback arrived after its task scope closed");
      }
    }
  );
}

async function main(): i32 on thread.main {
  const applicationValue = new Application({
    state: Mutex(ApplicationState({ observed: 0 })),
    published: 0,
  });
  const applicationLifetime = initializeApplication(applicationValue);

  const value = await Swift.ZSwiftBackgroundWorker.calculate(40);
  const mainActorWork = thread.spawn(async (): i32 => {
    return await on thread.main {
      select await Swift.ZSwiftMainActorWorker.calculate(40);
    };
  });
  const mainActorValue = await mainActorWork;
  const checked = attempt await Swift.ZSwiftBackgroundWorker.calculateChecked(
    40,
    shouldFail: false
  );
  const checkedValue = match (checked) {
    success(value) => value;
    failure(error) => {
      console.log(error.code);
      select 0;
    }
  };
  const failed = attempt await Swift.ZSwiftBackgroundWorker.calculateChecked(
    40,
    shouldFail: true
  );
  const failureStatus = match (failed) {
    success(value) => value;
    failure(error) => {
      console.log(error.code);
      select 0;
    }
  };
  await on thread.main {
    const label = AppKit.NSTextField.alloc().initWithFrame(
      AppKit.NSMakeRect(0.0, 0.0, 240.0, 24.0)
    );
    label.sizeToFit();
    console.log(value);
  }
  const cancelled = task Swift.ZSwiftBackgroundWorker.calculateDelayed(1);
  await delay(1);
  await cancelled.cancel();

  async scope updates {
    observeSwiftCallback(updates);
    Swift.ZSwiftBackgroundWorker.waitForCompletion();
  }
  const current = currentApplication();
  return value - 42
    + mainActorValue - 42
    + checkedValue - 42
    + failureStatus
    + current.observed() - 42
    + current.published - 42;
}
