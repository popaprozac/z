import { TaskScope } from "std/async";
import { thread } from "std/thread";

class Runtime on thread.main {
  readonly updates: TaskScope;
}

function inspect(in runtime: Runtime): i32 on thread.main {
  const updates = runtime.updates;
  return 1;
}

async function complete(): void {
  return;
}

async function main(): i32 on thread.main {
  const runtime = new Runtime({ updates: new TaskScope() });
  const result = inspect(in runtime) + inspect(in runtime) - 2;
  const updates = runtime.updates;
  const control = updates.schedule(
    thread.main,
    async move (): void => await complete()
  );
  const accepted: boolean = control.accepted;
  await updates.close();
  return result + (accepted ? 0 : 1);
}
