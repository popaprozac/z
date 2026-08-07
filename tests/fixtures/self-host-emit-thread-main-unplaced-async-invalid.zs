import { thread } from "std/thread";

async function load(): i32 on thread.main {
  return 42;
}

async function main(): i32 on thread.main {
  return await load() - 42;
}
