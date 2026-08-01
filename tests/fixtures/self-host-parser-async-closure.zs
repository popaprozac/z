import { thread } from "std/thread";

function refreshProject(): i32 {
  return 42;
}

function publishApplicationStatus(ticket: i32): void on thread.main {
  return;
}

async function main(): i32 {
  const work = thread.spawn(async (): i32 => {
    const ticket = refreshProject();
    await on thread.main publishApplicationStatus(ticket);
    return ticket;
  });
  return await work;
}
