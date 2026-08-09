import console from "std/console";
import { delay } from "std/time";
import { thread } from "std/thread";

struct MatchPayload {
  id: i32;

  deinit {
    console.log(`released failed match payload ${this.id}`);
  }
}

struct PublishError {
  code: i32;
}

enum Route {
  fail MatchPayload,
  idle,
}

async function publish(
  route: Route
): i32 throws PublishError on thread.main {
  match (route) {
    fail(payload) => {
      const code = payload.id;
      await delay(1);
      throw PublishError({ code });
    }
    idle => {
      return 0;
    }
  }
}

async function main(): i32 on thread.main {
  const worker = thread.spawn(async (): i32 throws PublishError => {
    const payload = MatchPayload({ id: 42 });
    const route = Route.fail(move payload);
    return try await on thread.main publish(move route);
  });
  const result = attempt await worker;
  return match (result) {
    success(value) => value;
    failure(error) => error.code - 42;
  };
}
