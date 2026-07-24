import console from "std/console";

struct Job {
  id: i32;

  deinit {
    console.log(`released child job ${this.id}`);
  }
}

class Worker {
  id: i32;

  async function read(): i32 {
    return this.id;
  }

  deinit {
    console.log(`released task worker ${this.id}`);
  }
}

async function fetch(value: i32): i32 throws i32 {
  return value;
}

async function consume(job: Job): i32 {
  return job.id;
}

async function finish(job: Job): void {
  return;
}

async function fail(): i32 throws i32 {
  throw 7;
}

async function main(): i32 throws i32 {
  const worker = new Worker({ id: 24 });
  const job = Job({ id: 22 });
  const backgroundJob = Job({ id: 23 });
  const firstTask = task fetch(20);
  const jobTask = task consume(job);
  const workerTask = task worker.read();
  const failureTask = task fail();
  task finish(backgroundJob);
  const parentValue = 18;
  const first = try await firstTask;
  const second = await jobTask;
  const third = await workerTask;
  const failure = attempt await failureTask;
  return parentValue == 18 && first == 20 && second == 22 && third == 24 ? 0 : 1;
}
