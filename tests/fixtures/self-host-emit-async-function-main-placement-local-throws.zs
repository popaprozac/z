import console from "std/console";
import { delay } from "std/time";
import { thread } from "std/thread";

struct PublishRequest {
  message: String;

  deinit {
    console.log(`released request ${this.message}`);
  }
}

struct PublishError {
  message: String;

  deinit {
    console.log(`released error ${this.message}`);
  }
}

function duplicate(in value: String): String {
  return value.copyBytes(0, value.byteLength);
}

async function publish(
  request: PublishRequest
): i32 throws PublishError on thread.main {
  await delay(1);
  throw PublishError({ message: duplicate(request.message) });
}

async function handle(
  request: PublishRequest
): i32 throws PublishError {
  const status = try await on thread.main publish(
    request
  );
  console.log(`published ${status}`);
  return status;
}

async function main(): i32 on thread.main {
  const handled = attempt await handle(
    PublishRequest({ message: duplicate("typed publish") })
  );
  return match (handled) {
    success(_) => 1;
    failure(error) => error.message == "typed publish" ? 0 : 2;
  };
}
