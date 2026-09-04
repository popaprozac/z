import { thread } from "std/thread";

async function loadValue(): i32 on thread.main {
  return 42;
}

readonly class MainModel on thread.main {
  async function load(): i32 {
    return await loadValue();
  }
}

async function main(): i32 on thread.main {
  const model = new MainModel({});
  const value = await model.load();
  return value - 42;
}
