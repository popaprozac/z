import console from "std/console";
import { delay } from "std/time";
import { thread } from "std/thread";

struct CallError {
  code: i32;
}

function double(value: i32): i32 {
  return value * 2;
}

async function check(value: i32): i32 throws CallError {
  await delay(1);
  if (value < 0) throw CallError({ code: -value });
  return value;
}

async function publish(steps: i32): i32 on thread.main {
  let done = 0;
  while (done < steps) {
    done = done + 1;
    await delay(1);
    console.log(`published ${done}/${steps} on main`);
  }
  return done;
}

async function relay(value: i32): i32 {
  await delay(1);
  const doubled = await on thread.main double(value);
  return doubled;
}

async function main(): i32 {
  const viaMain = await relay(4);
  console.log(`relay on main ${viaMain}`);
  const worker = thread.spawn(async (): i32 throws CallError => {
    await delay(1);
    const doubled = await on thread.main double(21);
    const checked = try await on thread.main check(doubled);
    const published = await on thread.main publish(2);
    const relayed = await relay(1);
    return checked + published + relayed;
  });
  const total = attempt await worker;
  const value = match (total) {
    success(result) => result;
    failure(error) => error.code;
  };
  console.log(`worker ${value}`);
  return value - 46;
}
