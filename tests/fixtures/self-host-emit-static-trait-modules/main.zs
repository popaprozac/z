import {
  Context,
  Lifecycle,
  LifecycleAdapter,
  LifecycleError,
  adapt,
} from "./contract.zs";
import console from "std/console";
import { thread } from "std/thread";

struct PrivateLifecycle implements Lifecycle {
  marker: String;

  function start(in context: Context): void
    throws LifecycleError on thread.main {}

  deinit {
    console.log(`released ${this.marker}`);
  }
}

function main(): i32 {
  const adapter: LifecycleAdapter = adapt(PrivateLifecycle({
    marker: "owned",
  }));
  const context = Context({ name: "probe" });
  return match (adapter.invoke(in context)) {
    success => 0;
    failure(_) => 1;
  };
}
