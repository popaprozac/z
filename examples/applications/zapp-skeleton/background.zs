import { sleep } from "std/time";
import { currentApplication } from "./application.zs";

// A framework subsystem does not need an Application parameter threaded
// through every layer. Retrieval is synchronized; member contracts still
// determine which parts of the identity are legal on this worker.
export function refreshProject(): i32 {
  const current = currentApplication();
  const ticket = current.beginWork();
  sleep(10);
  current.finishWork(ticket);
  return ticket;
}
