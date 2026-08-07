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
  const applicationRoot = new Application({
    name: "Zapp",
    state: Mutex(RuntimeState({ started: 0, completed: 0 })),
    status: "Starting",
  });
  const lifetime = initializeApplication(applicationRoot);

  const refresh = thread.spawn(async (): String throws i32 => {
    const ticket = refreshProject();

    // Native work stays on its dedicated worker until the API explicitly hops
    // back to the application's owning executor.
    return try await on thread.main publishApplicationStatus(ticket);
  });

  const refreshed = attempt await refresh;
  const status: String = match (refreshed) {
    success(publishedStatus) => publishedStatus;
    failure(error) => return -error;
  };
  const current = currentApplication();
  console.log(`${current.name}: ${status}`);
  return current.completedWork() - 1;
}
