import { thread } from "std/thread";

struct WorkError {
  message: String;
}

function duplicate(in value: String): String {
  return value.copyBytes(0, value.byteLength);
}

async function main(): i32 throws WorkError {
  const inferredWorker = thread.spawn((): String throws WorkError => {
    return duplicate("inferred");
  });
  const inferred = try await inferredWorker;

  const returnedWorker = thread.spawn((): i32 throws WorkError => {
    return 0;
  });
  if (inferred.byteLength == 8) return try await returnedWorker;
  return -1;
}
