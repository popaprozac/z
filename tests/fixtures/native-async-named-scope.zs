import console from "std/console";
import { TaskControl, TaskScope } from "std/async";
import { thread } from "std/thread";
import { delay } from "std/time";

// A named `async scope` binds a `TaskScope` handle for its body. Leaving the
// scope closes the handle and joins every operation it accepted, on every way
// out: the end of the body, `return`, `break`, and `continue`. A `throw`
// cancels the operations instead, and so does cancelling the function.

enum Failure { broken }

async function announce(value: i32, wait: u64): void {
  console.log(`operation ${value} started`);
  await delay(wait);
  console.log(`operation ${value} finished`);
}

function submit(updates: TaskScope, value: i32, wait: u64): boolean {
  const control: TaskControl = updates.schedule(thread.main, async move (): void => await announce(value, wait));
  return control.accepted;
}

function submitPlain(updates: TaskScope, value: i32): boolean {
  const control: TaskControl = updates.schedule(thread.main, move (): void => {
    console.log(`plain operation ${value}`);
  });
  return control.accepted;
}

function run(action: () => void): void {
  action();
}

async function child(value: i32): i32 {
  await delay(1);
  console.log(`child ${value}`);
  return value;
}

async function joins(): i32 {
  async scope updates {
    const plain = submitPlain(updates, 1);
    const suspended = submit(updates, 2, 2);
    console.log(`joins body ${plain} ${suspended}`);
  }
  console.log("joins after scope");
  return 1;
}

// The scope joins the children started in it and its handle's operations.
async function children(): i32 {
  async scope updates {
    task child(3);
    const plain = submitPlain(updates, 4);
    console.log(`children body ${plain}`);
  }
  console.log("children after scope");
  return 2;
}

async function leaves(early: boolean): i32 {
  async scope updates {
    const accepted = submit(updates, 5, 2);
    if (early) return 5;
    console.log(`leaves late ${accepted}`);
  }
  return 6;
}

async function raises(): i32 throws Failure {
  async scope updates {
    const accepted = submit(updates, 7, 5000);
    // The operation starts, then the throw cancels it.
    await delay(1);
    if (accepted) throw Failure.broken;
    console.log("raises body should not continue");
  }
  return 9;
}

async function loops(): i32 {
  let round = 0;
  while (round < 3) {
    async scope updates {
      const accepted = submitPlain(updates, 10 + round);
      round = round + 1;
      if (round == 2) continue;
      if (round == 3) break;
      console.log(`round ${round} body ${accepted}`);
    }
    console.log(`round ${round} after scope`);
  }
  return round;
}

class Publisher {
  label: String;

  async function publish(count: i32): i32 {
    let sent = 0;
    async scope updates {
      while (sent < count) {
        const accepted = submitPlain(updates, 20 + sent);
        if (accepted) sent = sent + 1;
      }
      console.log(`${this.label} queued ${sent}`);
    }
    return sent;
  }
}

// Scopes nest, a closure may capture a handle, and scopes that follow one
// another may reuse a name.
async function nests(): i32 {
  async scope outer {
    const first = submitPlain(outer, 30);
    async scope inner {
      const second = submitPlain(inner, 31);
      run(move (): void => {
        const third = submitPlain(outer, 32);
        console.log(`nests captured ${third}`);
      });
      console.log(`nests inner ${first} ${second}`);
    }
    console.log("nests between");
  }
  async scope outer {
    const again = submitPlain(outer, 33);
    console.log(`nests again ${again}`);
  }
  return 4;
}

async function fromWorker(): boolean {
  let accepted = false;
  async scope updates {
    const worker = thread.spawn(move (): boolean => submitPlain(updates, 40));
    accepted = await worker;
  }
  return accepted;
}

async function long(): i32 {
  async scope updates {
    const accepted = submit(updates, 50, 5000);
    console.log(`long accepted ${accepted}`);
    await delay(5000);
    console.log("long body should not finish");
  }
  return 2;
}

async function main(): i32 {
  const joined = await joins();
  const withChildren = await children();
  console.log(`joined ${joined} ${withChildren}`);
  const early = await leaves(true);
  console.log(`leaves ${early}`);
  const late = await leaves(false);
  console.log(`leaves ${late}`);
  const raised = attempt await raises();
  match (raised) {
    success(value) => console.log(`raises returned ${value}`);
    failure(_) => console.log("raises failed");
  }
  const rounds = await loops();
  console.log(`loops ${rounds}`);
  const publisher = new Publisher({ label: "publisher" });
  const sent = await publisher.publish(2);
  console.log(`published ${sent}`);
  const nested = await nests();
  console.log(`nests ${nested}`);
  const submitted = await fromWorker();
  console.log(`worker submitted ${submitted}`);
  const pending = task long();
  await delay(20);
  await pending.cancel();
  console.log("cancelled");
  return 0;
}
