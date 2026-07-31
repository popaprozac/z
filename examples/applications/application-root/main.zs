import console from "std/console";
import { thread } from "std/thread";
import {
  Application,
  currentApplication,
  initializeApplication,
} from "./application.zs";
import { currentRevision } from "./status.zs";

async function main(): i32 on thread.main {
  const value = new Application({
    name: "Z desktop",
    revision: 42,
  });
  const lifetime = initializeApplication(value);

  const worker = thread.spawn(async (): i32 => {
    return await on thread.main {
      select currentRevision();
    };
  });

  const revision = await worker;
  const current = currentApplication();
  console.log(`${current.name} revision=${revision}`);
  return revision - 42;
}
