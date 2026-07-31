import console from "std/console";
import { thread } from "std/thread";
import {
  Application,
  ApplicationState,
  currentApplication,
  initializeApplication,
} from "./application.zs";
import { Mutex } from "std/sync";
import { currentRevision } from "./status.zs";

async function main(): i32 on thread.main {
  const value = new Application({
    name: "Z desktop",
    state: Mutex(ApplicationState({ revision: 42 })),
    windowId: 7,
  });
  const lifetime = initializeApplication(value);

  // Retrieval is synchronized and the mixed-affinity identity may be retained
  // by a worker. Only its thread-safe surface is usable there.
  const worker = thread.spawn((): i32 => currentRevision());

  const revision = await worker;
  const current = currentApplication();
  console.log(`${current.name} revision=${revision}`);
  return revision - current.currentWindowId() - 35;
}
