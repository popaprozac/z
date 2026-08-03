import { thread } from "std/thread";

readonly class Presenter on thread.main {
  value: i32;
}

async function main(): i32 on thread.main {
  const presenter = new Presenter({ value: 42 });
  const worker = thread.spawn(move (): i32 => presenter.value);
  return await worker;
}
