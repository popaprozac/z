import console from "std/console";
import { scheduler } from "std/async";

struct Request {
  label: String;
  deinit { console.log(`released ${this.label}`); }
}
struct DeliveryError {
  message: String;
  deinit { console.log(`released error ${this.message}`); }
}

async function deliver(request: Request, reject: boolean): i32 throws DeliveryError {
  let turns = 0;
  while (turns < 2) {
    await scheduler.yield();
    turns = turns + 1;
  }
  if (reject) throw DeliveryError({ message: "rejected" });
  return i32(request.label.byteLength);
}

async function listen(request: Request, reject: boolean): i32 throws DeliveryError {
  const endpoint = Request({ label: "endpoint" });
  await scheduler.yield();
  const received = try await deliver(move request, reject);
  await scheduler.yield();
  console.log(endpoint.label);
  return received;
}

function inspect(result: Result<i32, DeliveryError>): i32 {
  return match (result) {
    success(value) => value;
    failure(error) => i32(error.message.byteLength);
  };
}

async function wake(): void { await scheduler.yield(); }

function validate(count: i32): void throws DeliveryError {
  if (count < 0) throw DeliveryError({ message: "invalid" });
}

async function batch(): void throws DeliveryError {
  let count = 0;
  while (count < 2) {
    try validate(count);
    try await deliver(Request({ label: "batch" }), false);
    await wake();
    await scheduler.yield();
    count = count + 1;
  }
}

async function prepare(): Request { return Request({ label: "snapshot" }); }

async function readSnapshot(): i32 {
  const snapshot = await prepare();
  await scheduler.yield();
  return i32(snapshot.label.byteLength);
}

async function readAgain(): i32 {
  await scheduler.yield();
  return await readSnapshot();
}

function inspectBatch(result: Result<void, DeliveryError>): i32 {
  return match (result) {
    success => 0;
    failure(_) => 1;
  };
}

async function main(): i32 {
  await scheduler.yield();
  const first = attempt await listen(Request({ label: "first" }), false);
  const second = attempt await listen(Request({ label: "second" }), true);
  const finished = attempt await batch();
  const snapshot = await readAgain();
  return inspect(move first) + inspect(move second) + inspectBatch(move finished) + snapshot - 21;
}
