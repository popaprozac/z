import { thread } from "std/thread";

struct OwnedError {
  message: String;
}

function duplicate(in value: String): String {
  return value.copyBytes(0, value.byteLength);
}

async function main(): i32 throws OwnedError {
  const worker = thread.spawn((): String throws OwnedError => {
    const shouldFail = true;
    if (shouldFail) {
      throw OwnedError({ message: "worker failed" });
    }
    return duplicate("owned success");
  });
  const value: String = try await worker;
  return i32(value.byteLength) - 13;
}
