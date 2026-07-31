import { sleep } from "std/time";
import { currentApplication } from "./application.zs";

export function refreshProject(): i32 {
  const current = currentApplication();
  const ticket = current.beginWork();
  sleep(250);
  current.finishWork(ticket);
  return ticket;
}
