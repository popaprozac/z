// Match arms that suspend in general native frames: a suspending arm keeps
// its payload in the frame, and an owned payload is released at arm end,
// moved out, or released by cancellation, once. (Awaiting inside a borrowed
// match is rejected by both compilers: the borrow would span the await.)
import console from "std/console";
import { delay } from "std/time";

struct Job {
  id: i32;

  deinit {
    console.log(`released job ${this.id}`);
  }
}

enum Lookup {
  cached Job,
  remote i32,
  missing i32,
}

struct LookupError {
  code: i32;
}

async function loadRemote(id: i32): Job {
  await delay(1);
  return Job({ id });
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

async function consume(lookup: Lookup): void {
  match (lookup) {
    cached(job) => {
      await delay(1);
      console.log(`consumed cached ${job.id}`);
    }
    remote(id) => console.log(`consumed remote ${id}`);
    missing(code) => console.log(`consumed missing ${code}`);
  }
  console.log("consume done");
}

async function main(): i32 {
  const cached = attempt await resolve(Lookup.cached(Job({ id: 1 })));
  const cachedId = match (cached) {
    success(job) => job.id;
    failure(error) => -error.code;
  };
  const remote = attempt await resolve(Lookup.remote(2));
  const remoteId = match (remote) {
    success(job) => job.id;
    failure(error) => -error.code;
  };
  const missing = attempt await resolve(Lookup.missing(3));
  const missingId = match (missing) {
    success(job) => job.id;
    failure(error) => -error.code;
  };
  console.log(`resolved ${cachedId} ${remoteId} ${missingId}`);
  await consume(Lookup.cached(Job({ id: 6 })));
  await consume(Lookup.missing(7));
  return cachedId - 1 + remoteId - 2 + missingId + 3;
}
