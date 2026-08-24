import { thread } from "std/thread";

type Handler = () => i32 on thread.main;

struct PublishError {
  code: i32;
}

type FallibleHandler = () => void throws PublishError on thread.main;

class Controller on thread.main {
  value: i32;

  function read(): i32 {
    return this.value;
  }
}

struct Registry {
  handler: Handler;
}

struct Application {
  registry: Registry = createRegistry();
}

struct Lifecycle {
  handler: FallibleHandler;

  function run(): void throws PublishError on thread.main {
    try this.handler();
  }
}

function direct(): i32 on thread.main {
  return 42;
}

function anywhere(): i32 on thread.any {
  return 42;
}

function createRegistry(): Registry on thread.main {
  return Registry({ handler: direct });
}

function warm(): void throws PublishError on thread.main {
  return;
}

function main(): i32 on thread.main {
  const application = Application();
  if (application.registry.handler() != 42) return 1;

  const controller = new Controller({ value: 42 });
  const captured: Handler = move () => controller.read();
  const registry = Registry({ handler: captured });
  if (registry.handler() != 42) return 2;

  const named: Handler = direct;
  if (named() != 42) return 3;

  const stronger: Handler = anywhere;
  if (stronger() != 42) return 4;

  let controllers = Array<Controller>();
  controllers.push(new Controller({ value: 42 }));
  const stored: Controller = controllers[0];
  if (stored.read() != 42) return 5;

  const lifecycle = Lifecycle({ handler: warm });
  const lifecycleResult = attempt lifecycle.run();
  return match (lifecycleResult) {
    success => 0;
    failure(error) => error.code;
  };
}
