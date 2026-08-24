import {
  Lifecycle,
  LifecycleBuilder,
  createLifecycleBuilder,
} from "./contract.zs";
import console from "std/console";

struct PrivateLifecycle implements Lifecycle {
  marker: String;

  function start(): i32 {
    return 42;
  }

  deinit {
    console.log(`released ${this.marker}`);
  }
}

function main(): i32 {
  let builder: LifecycleBuilder = createLifecycleBuilder();
  builder.register(PrivateLifecycle({ marker: "private" }));
  return builder.values[0] - 42;
}
