import console from "std/console";
import { delay } from "std/time";
import { thread } from "std/thread";

struct WorkError {
  code: i32;
}

struct Job {
  id: i32;
  label: String;
}

async function build(value: i32): i32 {
  await delay(1);
  return value;
}

async function check(value: i32): i32 throws WorkError {
  await delay(1);
  if (value < 0) throw WorkError({ code: -value });
  return value;
}

async function main(): i32 {
  // A worker frame: awaits, a delay, a spawned child, and an owned capture.
  const job = Job({ id: 7, label: "report" });
  const worker = thread.spawn(async move (): String => {
    const first = await build(20);
    await delay(1);
    const childTask = task build(22);
    const second = await childTask;
    return `${job.label} ${job.id} ${first + second}`;
  });
  const summary = await worker;
  console.log(summary);

  // A throwing worker: its error reaches the joining frame.
  const failing = thread.spawn(async (): i32 throws WorkError => {
    const ok = try await check(5);
    const bad = try await check(-3);
    return ok + bad;
  });
  const failed = attempt await failing;
  const code = match (failed) {
    success(value) => value;
    failure(error) => error.code;
  };
  console.log(`failure ${code}`);

  // A worker cancelled while its frame is asleep releases what it owns.
  const name = "sleeper";
  const sleeper = thread.spawn(async move (): i32 => {
    await delay(1000);
    console.log(`woke ${name}`);
    return 1;
  });
  await delay(5);
  await sleeper.cancel();
  console.log("cancelled sleeper");
  return code - 3;
}
