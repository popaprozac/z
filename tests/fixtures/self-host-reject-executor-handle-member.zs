import { thread } from "std/thread";

class Application {
  readonly name: String;
  windowId: i32 on thread.main;

  function windowValue(): i32 on thread.main {
    return this.windowId;
  }
}

struct RouteContext {
  application: Application;
}

function contextFor(in application: Application): RouteContext {
  return RouteContext({ application });
}

function inspect(in context: RouteContext): i32 {
  return context.application.windowValue();
}

function main(): i32 on thread.main {
  const application = new Application({ name: "Z", windowId: 7 });
  const context = contextFor(application);
  return inspect(in context);
}
