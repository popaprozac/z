import { thread } from "std/thread";
import {
  Application,
  currentApplication,
  previewApplication,
} from "./state.zs";

function updateAndInspect(
  inout updated: Application,
  in observed: Application
): i32 on thread.main {
  updated.increment();
  return observed.read();
}

function main(): i32 on thread.main {
  let primary = currentApplication();
  const preview = previewApplication();
  return updateAndInspect(inout primary, preview);
}
