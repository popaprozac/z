import { scheduler } from "std/async";

class RunState {
  value: i32;
}

async function load(): i32 {
  await scheduler.yield();
  return 42;
}

async function observe(): i32 {
  const state = new RunState({ value: 42 });
  const loaded = await load();
  return state.value == loaded ? 0 : 1;
}

async function main(): i32 {
  return await observe();
}
