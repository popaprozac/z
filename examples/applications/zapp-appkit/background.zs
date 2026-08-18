import { sleep } from "std/time";
import { currentApplication } from "./application.zs";
import { Message } from "../message-router/router.zs";

export function refreshProject(): i32 {
  const current = currentApplication();
  const ticket = current.beginWork();
  sleep(250);
  const backgroundMessage = Message({
    operation: "background-job",
    value: ticket,
  });
  const routed = attempt current.route(in backgroundMessage);
  const routedTicket = match (routed) {
    success(value) => value;
    failure(_) => 0;
  };
  const rejectedMessage = Message({
    operation: "reject-action",
    value: routedTicket,
  });
  const rejected = attempt current.route(in rejectedMessage);
  const verifiedTicket = match (rejected) {
    success(_) => 0;
    failure(_) => routedTicket;
  };
  current.finishWork(verifiedTicket);
  return verifiedTicket;
}
