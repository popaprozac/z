// Both compiler paths preserve selected owned fields across suspension.
import { scheduler } from "std/async";

struct Failure {
  code: i32;
  message: String;
}

async function main(): i32 {
  const error = Failure({ code: 7, message: "setup failed" });
  const { code, message } = move error;
  await scheduler.yield();
  return message.byteLength == 12 ? code - 7 : 1;
}
