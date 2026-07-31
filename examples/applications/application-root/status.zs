import { currentApplication } from "./application.zs";

export function currentRevision(): i32 {
  const current = currentApplication();
  return current.revision();
}
