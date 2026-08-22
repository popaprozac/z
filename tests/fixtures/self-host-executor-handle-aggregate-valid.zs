import { thread } from "std/thread";

class Application {
  readonly name: String;
  windowId: i32 on thread.main;

  function nameBytes(): usize {
    return this.name.byteLength;
  }
}

struct RouteContext {
  application: Application;
}

function contextFor(in application: Application): RouteContext {
  return RouteContext({ application });
}

function inspect(in context: RouteContext): usize {
  return context.application.nameBytes();
}

function main(): i32 on thread.main {
  const application = new Application({ name: "Z", windowId: 7 });
  const context = contextFor(application);
  return i32(inspect(in context)) - 1;
}
