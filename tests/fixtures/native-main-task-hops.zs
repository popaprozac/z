import console from "std/console";
import { delay } from "std/time";
import { thread } from "std/thread";

function announce(value: i32): void {
  console.log(`announce ${value}`);
}

async function note(value: i32): i32 {
  task on thread.main {
    console.log(`note ${value}`);
  }
  await delay(1);
  return value + 1;
}

async function main(): i32 {
  // A synchronous worker: its main children are joined before it completes.
  const label = "sync";
  const first = thread.spawn(move (): i32 => {
    const answer = 42;
    task on thread.main {
      console.log(`${label} block ${answer}`);
    }
    task on thread.main announce(answer);
    return answer;
  });
  const firstValue = await first;
  console.log(`first ${firstValue}`);

  // An async worker spawns a main child, keeps working, and joins it on exit.
  const second = thread.spawn(async (): i32 => {
    task on thread.main {
      await delay(2);
      console.log("async child done");
    }
    const noted = await note(7);
    console.log(`worker noted ${noted}`);
    return noted;
  });
  const secondValue = await second;
  console.log(`second ${secondValue}`);

  // `main` spawns placed children on its own executor.
  const seed = 5;
  const child = task on thread.main: i32 {
    await delay(1);
    select seed + 1;
  };
  task on thread.main {
    console.log("statement child");
  }
  const result = await child;
  console.log(`result ${result}`);
  return firstValue + secondValue + result - 56;
}
