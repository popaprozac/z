import { createLifecycleBuilder } from "./contract.zs";
import { createService } from "./service.zs";

function main(): i32 {
  let builder = createLifecycleBuilder();
  builder.register(createService());
  return builder.values[0] - 42;
}
