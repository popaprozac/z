import { scheduler } from "std/async";

readonly struct Context {
  arguments: readonly Array<String>;
}

readonly class Application {
  context: Context;
}

function createApplication(): Application {
  const arguments = Array<String>("primary");
  return new Application({
    context: Context({ arguments: arguments.freeze() }),
  });
}

async function child(): i32 {
  await scheduler.yield();
  return 0;
}

async function main(): i32 {
  const app = createApplication();
  if (app.context.arguments.length != 1) return 1;
  const mode = copy app.context.arguments[0];
  const result = await child();
  if (app.context.arguments[0] != mode) return 2;
  return result;
}
