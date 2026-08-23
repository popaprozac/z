import { thread } from "std/thread";

type Handler = () => i32 on thread.main;

class Controller on thread.main {
  value: i32;

  function read(): i32 {
    return this.value;
  }
}

struct Registry {
  handler: Handler;
}

function direct(): i32 on thread.main {
  return 42;
}

function anywhere(): i32 on thread.any {
  return 42;
}

function main(): i32 on thread.main {
  const controller = new Controller({ value: 42 });
  const captured: Handler = move () => controller.read();
  const registry = Registry({ handler: captured });
  if (registry.handler() != 42) return 1;

  const named: Handler = direct;
  if (named() != 42) return 2;

  const stronger: Handler = anywhere;
  return stronger() - 42;
}
