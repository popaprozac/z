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

async function main(): i32 on thread.main {
  const service = new Service({});
  const first = await dispatch(
    service,
    ServiceRequest({ title: "ready" })
  );
  const second = await dispatch(
    service,
    ServiceRequest({ title: "fail" })
  );
  const firstStatus = match (first) {
    success(value) => value == "ready" ? 0 : 1;
    failure(_) => 2;
  };
  if (firstStatus != 0) return firstStatus;
  return match (second) {
    success(_) => 3;
    failure(value) => value == "fail" ? 0 : 4;
  };
}
