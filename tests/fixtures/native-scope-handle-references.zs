import console from "std/console";
import { TaskControl, TaskScope } from "std/async";
import { thread } from "std/thread";
import { delay } from "std/time";

// A scope and the controls it hands out are shared handles: passing one on by
// value, returning it, or capturing it leaves the caller's own reference in
// place, and every holder lets go of exactly one.

function accepted(control: TaskControl): boolean {
  return control.accepted;
}

function submit(jobs: TaskScope, value: i32): boolean {
  const control: TaskControl = jobs.schedule(thread.main, move (): void => {
    console.log(`job ${value}`);
  });
  const first = accepted(control);
  const second = accepted(control);
  return first && second;
}

function forward(jobs: TaskScope, value: i32): boolean {
  return submit(jobs, value);
}

function pick(jobs: TaskScope): TaskScope {
  return jobs;
}

function relay(jobs: TaskScope, value: i32, deliver: (value: i32) => boolean): boolean {
  return deliver(value);
}

function relayed(jobs: TaskScope, value: i32): boolean {
  return relay(jobs, value, move (received: i32): boolean => forward(jobs, received));
}

async function hold(jobs: TaskScope, value: i32): boolean {
  await delay(1);
  return forward(jobs, value);
}

async function main(): i32 {
  await delay(1);
  const jobs = new TaskScope();
  const direct = forward(jobs, 1);
  const picked = pick(jobs);
  const again = forward(picked, 2);
  const third = relayed(jobs, 3);
  const fourth = await hold(jobs, 4);
  await jobs.close();
  console.log(`accepted ${direct} ${again} ${third} ${fourth}`);
  return 0;
}
