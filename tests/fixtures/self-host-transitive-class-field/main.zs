import {
  Config,
  createConfig,
} from "./api.zs";

function main(): i32 {
  const config: Config = createConfig();
  let counter = config.counter;
  counter.add(2);
  return counter.value - 42;
}
