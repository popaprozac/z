import { thread } from "std/thread";
import { delay } from "std/time";

struct ServiceRequest {
  title: String;
}

struct ServiceError {
  message: String;
}

enum ServiceOutcome {
  success String,
  failure String,
}

readonly class Service {
  async function create(
    request: ServiceRequest
  ): String throws ServiceError on thread.main {
    await delay(1);
    if (request.title == "fail") {
      throw ServiceError({ message: copy request.title });
    }
    return copy request.title;
  }
}

async function dispatch(
  service: Service,
  request: ServiceRequest
): ServiceOutcome {
  const called = attempt await on thread.main service.create(
    move request
  );
  return match (called) {
    success(value) => ServiceOutcome.success(move value);
    failure(error) => {
      const message = copy error.message;
      const scratch = ServiceError({ message: "scoped" });
      return ServiceOutcome.failure(move message);
    }
  };
}

// A worker frame runs off the main thread: awaiting `dispatch`, whose placed
// call runs where `dispatch` runs (its placed tier), is rejected.
async function main(): i32 {
  const worker = thread.spawn(async (): i32 => {
    await delay(1);
    const service = new Service({});
    const outcome = await dispatch(service, ServiceRequest({ title: "worker" }));
    return match (outcome) {
      success(_) => 0;
      failure(_) => 1;
    };
  });
  return await worker;
}
