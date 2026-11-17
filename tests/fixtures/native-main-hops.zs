import console from "std/console";
import { delay } from "std/time";
import { thread } from "std/thread";

struct HopError {
  code: i32;
}

async function check(value: i32): i32 throws HopError {
  await delay(1);
  if (value < 0) throw HopError({ code: -value });
  return value;
}

// An ordinary async function: its placed block hops to the main executor
// from whichever executor runs it.
async function label(value: i32, prefix: String): String {
  await delay(1);
  const text = await on thread.main: String {
    select `${prefix}-${value}`;
  };
  return text;
}

async function main(): i32 {
  const direct = await label(1, "main");
  console.log(direct);

  // Captured values are copied to the main executor; the worker keeps its own.
  const name = "worker";
  const copied = thread.spawn(async move (): String => {
    await delay(1);
    const greeting = await on thread.main: String {
      select `hello ${name}`;
    };
    const tagged = await label(2, copy name);
    return `${greeting} ${tagged} ${name}`;
  });
  const copiedText = await copied;
  console.log(copiedText);

  // A throwing block: its error reaches the worker, then the joiner.
  const failing = thread.spawn(async (): i32 throws HopError => {
    const good = try await on thread.main: i32 throws HopError {
      select try await check(4);
    };
    const bad = try await on thread.main: i32 throws HopError {
      select try await check(-6);
    };
    return good + bad;
  });
  const failed = attempt await failing;
  const code = match (failed) {
    success(value) => value;
    failure(error) => error.code;
  };
  console.log(`failure ${code}`);

  // Cancelling a worker while its block sleeps on the main executor cancels
  // the block there; the worker unwinds once the block reports back.
  const sleeper = thread.spawn(async (): i32 => {
    const slept = await on thread.main: i32 {
      await delay(1000);
      console.log("block woke");
      select 1;
    };
    console.log("worker resumed");
    return slept;
  });
  await delay(5);
  await sleeper.cancel();
  console.log("cancelled sleeper");
  return code - 6;
}
