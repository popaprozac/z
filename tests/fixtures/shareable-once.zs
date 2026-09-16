import { Mutex, Once, OnceLifetime, OnceState } from "std/sync";
import { thread } from "std/thread";
import console from "std/console";

struct Registry { count: usize; }

class Engine {
  readonly registry: Mutex<Registry>;
  deinit on thread.any { console.log("released engine"); }
}

const engine = Once<Engine>();

function start(): OnceLifetime<Engine> on thread.any {
  return engine.initialize(new Engine({ registry: Mutex(Registry({ count: 0 })) }));
}

function finish(lifetime: OnceLifetime<Engine>): i32 on thread.any {
  const current = engine.get();
  current.registry.withLock((inout state): void => { state.count = state.count + 1; });
  return 42;
}

function isEmpty(): boolean { return engine.state() == OnceState.empty; }
function isClosed(): boolean { return engine.state() == OnceState.closed; }

async function main(): i32 {
  if (!isEmpty()) return 1;
  const lifetime = start();
  const retained = engine.get();
  const worker = thread.spawn(move (): i32 => finish(move lifetime));
  const result = await worker;
  if (result != 42 || !isClosed()) return 2;
  // Closing publication does not invalidate a previously retained handle.
  const count = retained.registry.withLock((in state): usize => state.count);
  if (count != 1) return 3;
  return 0;
}
