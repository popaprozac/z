import console from "std/console";
import { Mutex } from "std/sync";
import { thread } from "std/thread";
import {
  Application,
  RuntimeState,
  currentApplication,
  initializeApplication,
  publishApplicationStatus,
} from "./application.zs";
import { refreshProject } from "./background.zs";

async function main(): i32 on thread.main {
  const value = new Application({
    name: "Zapp",
    state: Mutex(RuntimeState({ started: 0, completed: 0 })),
    status: "Starting",
  });
  const lifetime = initializeApplication(value);

  const refresh = thread.spawn(async (): i32 => {
    const ticket = refreshProject();

    // Native work stays on its dedicated worker until the API explicitly hops
    // back to the application's owning executor.
    await on thread.main publishApplicationStatus(ticket);
    return ticket;
  });

  const ticket = await refresh;
  const current = currentApplication();
  const status = current.currentStatus();
  console.log(`${current.name}: ${status}`);
  return current.completedWork() - ticket;
}
