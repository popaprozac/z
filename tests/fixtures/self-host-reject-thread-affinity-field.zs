import { Mutex, Once, OnceLifetime } from "std/sync";
import { thread } from "std/thread";

struct State {
  value: i32;
}

class Application {
  readonly state: Mutex<State>;
  published: i32 on thread.main;
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

async function main(): i32 on thread.main {
  const lifetime = initializeApplication(new Application({
    state: Mutex(State({ value: 42 })),
    published: 7,
  }));
  const job = thread.spawn(move (): i32 => {
    const current = currentApplication();
    return current.published;
  });
  return await job;
}
