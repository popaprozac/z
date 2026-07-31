import { thread } from "std/thread";
import { currentApplication } from "./application.zs";

export function currentRevision(): i32 on thread.main {
  const current = currentApplication();
  return current.revision;
}
