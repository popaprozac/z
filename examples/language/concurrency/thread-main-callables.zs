import { thread } from "std/thread";

type MainOperation = () => i32 on thread.main;

class WindowController on thread.main {
  revision: i32;

  function currentRevision(): i32 {
    return this.revision;
  }
}

struct OperationEntry {
  run: MainOperation;
}

function readBaseline(): i32 on thread.any {
  return 40;
}

function main(): i32 on thread.main {
  const controller = new WindowController({ revision: 2 });

  const readWindow: MainOperation = move () => controller.currentRevision();
  const entry = OperationEntry({ run: readWindow });
  const revision = entry.run();

  // An arbitrary-thread callable is safe to use through a main-only contract.
  const baseline: MainOperation = readBaseline;
  return baseline() + revision - 42;
}
