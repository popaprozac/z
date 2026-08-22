import { Application } from "./application.zs";
import {
  Message,
  RouteError,
} from "../message-router/router.zs";

export enum RouteRequest {
  action i32,
  background i32,
  rejection i32,
}

export struct RouteContext {
  application: Application;
  message: Message;
}

export function contextFor(
  in application: Application,
  request: RouteRequest
): RouteContext {
  match (request) {
    action(value) => return RouteContext({
      application,
      message: Message({ operation: "appkit-action", value }),
    });
    background(value) => return RouteContext({
      application,
      message: Message({ operation: "background-job", value }),
    });
    rejection(value) => return RouteContext({
      application,
      message: Message({ operation: "reject-action", value }),
    });
  }
}

export function dispatchContext(
  in context: RouteContext
): i32 throws RouteError {
  return try context.application.route(in context.message);
}
