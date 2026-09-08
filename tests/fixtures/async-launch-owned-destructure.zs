// Integration prerequisite, not an executable differential fixture yet.
// Stage 0 rejects async struct destructuring (Z0700). Native check accepts
// this body, but native run still rejects its combined frame at C emission.
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
