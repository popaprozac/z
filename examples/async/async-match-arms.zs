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
  found Job,
  missing i32,
}

async function score(id: i32): i32 {
  await delay(1);
  return id;
}

async function evaluate(lookup: Lookup): i32 throws LookupError {
  return match (lookup) {
    found(job) => {
      const weighted = await score(job.id);
      select job.id + weighted;
    }
    missing(code) => throw LookupError({ code });
  };
}

async function main(): i32 {
  const observed = attempt await evaluate(Lookup.found(new Job({ id: 21 })));
  const answer = match (observed) {
    success(value) => value;
    failure(error) => -error.code;
  };

  console.log(`async match selected ${answer}`);
  return answer - 42;
}
