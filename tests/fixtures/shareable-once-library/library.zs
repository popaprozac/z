import { Mutex, Once, OnceLifetime } from "std/sync";
import { thread } from "std/thread";
import console from "std/console";

struct Registry { count: i32; }

class Engine {
  readonly registry: Mutex<Registry>;
  deinit on thread.any { console.log("released shared root"); }
}

const engine = Once<Engine>();

function initializeRuntime(): OnceLifetime<Engine> on thread.any {
  return engine.initialize(new Engine({ registry: Mutex(Registry({ count: 0 })) }));
}

export c function shared_increment(): i32 {
  const current = engine.get();
  return current.registry.withLock((inout registry): i32 => {
    registry.count = registry.count + 1;
    return registry.count;
  });
}

export c function shared_count(): i32 {
  const current = engine.get();
  return current.registry.withLock((in registry): i32 => registry.count);
}
