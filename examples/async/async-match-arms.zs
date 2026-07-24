import console from "std/console";
import { delay } from "std/time";

class Job {
  id: i32;

  deinit {
    console.log(`released job ${this.id}`);
  }
}

struct LookupError {
  code: i32;
}

enum Lookup {
  cached Job,
  remote i32,
  missing i32,
}

async function loadRemote(id: i32): Job {
  await delay(1);
  return new Job({ id });
}

async function resolve(lookup: Lookup): Job throws LookupError {
  return match (lookup) {
    cached(job) => {
      await delay(1);
      select job;
    }
    remote(id) => await loadRemote(id);
    missing(code) => throw LookupError({ code });
  };
}

async function main(): i32 {
  const observed = attempt await resolve(Lookup.remote(42));
  const answer = match (observed) {
    success(job) => job.id;
    failure(error) => -error.code;
  };

  console.log(`async match selected ${answer}`);
  return answer - 42;
}
