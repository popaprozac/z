import console from "std/console";
import { delay } from "std/time";

struct DelayedJob {
  id: i32;

  deinit {
    console.log(`released delayed job ${this.id}`);
  }
}

function announceDelay(milliseconds: u64): void {
  console.log(`waiting ${milliseconds}ms`);
}

async function finishAfter(job: DelayedJob, milliseconds: u64): void {
  announceDelay(milliseconds);
  await delay(milliseconds);
  console.log(`finished delayed job ${job.id}`);
  return;
}

async function main(): i32 {
  async scope {
    // Both hot children suspend on independent timers. Scope exit joins them.
    spawn finishAfter(DelayedJob({ id: 1 }), 5);
    spawn finishAfter(DelayedJob({ id: 2 }), 1);
  }

  return 0;
}
