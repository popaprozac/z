import { delay } from "std/time";
import { Mutex, Once, OnceLifetime } from "std/sync";
import { thread } from "std/thread";

export struct RuntimeState {
  started: i32;
  completed: i32;
}

// Application is ordinary framework code. Its main-only presentation field
// determines lifecycle placement; its synchronized state remains usable from
// Z-managed workers.
export class Application {
  readonly name: String;
  readonly state: Mutex<RuntimeState>;
  status: String on thread.main;

  function beginWork(): i32 {
    return this.state.withLock((inout state): i32 => {
      state.started = state.started + 1;
      return state.started;
    });
  }

  function finishWork(ticket: i32): void {
    this.state.withLock((inout state): void => {
      state.completed = ticket;
    });
  }

  function completedWork(): i32 {
    return this.state.withLock(
      (in state): i32 => state.completed
    );
  }

  function publish(inout this, ticket: i32): void on thread.main {
    this.status = `Ready after background job ${ticket}`;
  }

  function currentStatus(): String on thread.main {
    return copy this.status;
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

export async function publishApplicationStatus(
  ticket: i32
): String throws i32 on thread.main {
  // This suspends without occupying main, then resumes the remaining
  // application publication on main.
  await delay(1);
  if (ticket < 0) {
    throw -1;
  }
  const current = currentApplication();
  current.publish(ticket);
  return current.currentStatus();
}
