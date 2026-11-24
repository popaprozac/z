import console from "std/console";
import { delay } from "std/time";

// `break` and `continue` inside an `async scope` leave it as its end does:
// the scope first joins the children it started, then releases the locals it
// lent them. The loop therefore never re-enters a scope whose children still
// run.

async function note(value: i32): void {
  await delay(1);
  console.log(`note ${value}`);
}

async function show(in label: String, value: i32): void {
  await delay(1);
  console.log(`${label} ${value}`);
}

async function loops(): i32 {
  let round = 0;
  while (round < 4) {
    async scope {
      task note(round);
      round = round + 1;
      if (round == 2) continue;
      if (round == 4) break;
      console.log(`round ${round} body end`);
    }
    console.log(`round ${round} after scope`);
  }
  return round;
}

// Both scopes are left at once; each child borrows a local of its scope.
async function nested(): i32 {
  let passes = 0;
  while (passes < 5) {
    async scope {
      const outer = `outer pass ${passes}`;
      task show(in outer, passes);
      async scope {
        const inner = `inner pass ${passes}`;
        task show(in inner, passes);
        passes = passes + 1;
        if (passes == 3) break;
        if (passes == 1) continue;
        console.log(`pass ${passes} inner end`);
      }
      console.log(`pass ${passes} outer end`);
    }
  }
  return passes;
}

async function main(): i32 {
  const rounds = await loops();
  console.log(`loops ${rounds}`);
  const passes = await nested();
  console.log(`nested ${passes}`);
  return 0;
}
