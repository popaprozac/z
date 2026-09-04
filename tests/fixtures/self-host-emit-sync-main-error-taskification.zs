import { thread } from "std/thread";

struct OperationError {
  message: String;
}

function checkedValue(value: i32): i32 throws OperationError {
  if (value < 0) throw OperationError({ message: "negative value" });
  return value;
}

readonly class Service {
  function update(value: i32): i32 throws OperationError on thread.main {
    const id = try checkedValue(value);
    return id + 1;
  }
}

async function callUpdateOnMain(
  service: Service,
  value: i32
): i32 throws OperationError on thread.main {
  return try service.update(value);
}

async function dispatch(service: Service, value: i32): i32 {
  const called = attempt await on thread.main callUpdateOnMain(
    move service,
    value
  );
  return match (called) {
    success(result) => result;
    failure(error) => i32(error.message.byteLength);
  };
}

async function main(): i32 on thread.main {
  const service = new Service({});
  const result = await dispatch(move service, -1);
  return result - 14;
}
