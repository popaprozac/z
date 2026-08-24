import { Lifecycle } from "./contract.zs";

export struct Service implements Lifecycle {
  function start(): i32 {
    return 42;
  }
}

export function createService(): Service {
  return Service({});
}
