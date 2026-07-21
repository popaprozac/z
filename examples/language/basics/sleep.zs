import console from "std/console";
import { sleep } from "std/time";

function main(): i32 {
  console.log("waiting for 1000 milliseconds");
  sleep(1000);
  console.log("done");
  return 0;
}
