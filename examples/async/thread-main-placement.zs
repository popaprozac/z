import console from "std/console";
import { thread } from "std/thread";

async function main(): i32 {
  const worker = thread.spawn((): void => {
    const answer = 42;

    spawn on thread.main {
      console.log(`main placement received ${answer}`);
    }
  });

  console.log("main task awaits worker without blocking the main executor");
  await worker;
  console.log("worker and its structured main child completed");
  return 0;
}
