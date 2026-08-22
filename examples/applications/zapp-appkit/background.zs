import { sleep } from "std/time";
import { currentApplication } from "./application.zs";
import {
  RouteRequest,
  contextFor,
  dispatchContext,
} from "./route-context.zs";

export function refreshProject(): i32 {
  const current = currentApplication();
  const ticket = current.beginWork();
  sleep(250);
  const background = contextFor(current, RouteRequest.background(ticket));
  const routed = attempt dispatchContext(in background);
  const routedTicket = match (routed) {
    success(value) => value;
    failure(_) => 0;
  };
  const rejection = contextFor(current, RouteRequest.rejection(routedTicket));
  const rejected = attempt dispatchContext(in rejection);
  const verifiedTicket = match (rejected) {
    success(_) => 0;
    failure(_) => routedTicket;
  };
  current.finishWork(verifiedTicket);
  return verifiedTicket;
}
