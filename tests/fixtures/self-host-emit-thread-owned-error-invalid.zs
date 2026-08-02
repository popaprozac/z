import { thread } from "std/thread";

struct OwnedError {
  message: String;
}

async function main(): i32 {
  const worker = thread.spawn((): i32 throws OwnedError => {
    throw OwnedError({ message: "worker failed" });
  });
  const observed = attempt await worker;
  return match (in observed) {
    success(value) => value;
    failure(_) => 1;
  };
}
