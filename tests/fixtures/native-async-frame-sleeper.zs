// Harness-driven: a general native async frame asleep on a timer observes
// cancellation at once and releases its owned frame storage.
import console from "std/console";
import { delay } from "std/time";

struct Job {
  id: i32;

  deinit {
    console.log(`released job ${this.id}`);
  }
}

async function sleeper(job: Job): i32 {
  console.log(`sleeping ${job.id}`);
  await delay(60000);
  console.log(`unexpected ${job.id}`);
  return job.id;
}

async function parent(job: Job): i32 {
  if (job.id > 0) {
    await sleeper(Job({ id: job.id + 1 }));
    console.log("unexpected parent");
  }
  return job.id;
}

async function supervisor(job: Job): void {
  task sleeper(Job({ id: job.id + 1 }));
  task sleeper(Job({ id: job.id + 2 }));
  await delay(60000);
  console.log(`unexpected supervisor ${job.id}`);
}

async function peek(in job: Job): i32 {
  await delay(60000);
  return job.id;
}

async function borrower(): i32 {
  await delay(1);
  const seen = await peek(Job({ id: 30 }));
  return seen;
}

async function scoped(): void {
  async scope {
    const held = Job({ id: 40 });
    task peek(held);
  }
}

enum Holder {
  held Job,
  empty i32,
}

async function holding(holder: Holder): void {
  match (holder) {
    held(job) => {
      await delay(60000);
      console.log(`unexpected held ${job.id}`);
    }
    empty(code) => console.log(`empty ${code}`);
  }
}

async function main(): i32 {
  return 0;
}
