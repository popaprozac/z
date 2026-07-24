import console from "std/console";
import { sleep } from "std/time";
import { thread } from "std/thread";
import native from "../../tests/fixtures/darwin-main-loop.h";

async function main(): i32 {
  const worker = thread.spawn((): void => {
    sleep(25);

    task on thread.main {
      console.log("placed child is running on the Darwin main run loop");
      native.z_test_stop_main_loop();
    };
  });

  native.z_test_run_main_loop();
  await worker;
  return 0;
}
