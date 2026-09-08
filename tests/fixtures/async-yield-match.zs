import console from "std/console";
import { scheduler } from "std/async";

struct ReceiveError {
  message: String;
  deinit { console.log(`released error ${this.message}`); }
}

function receive(turn: i32): boolean throws ReceiveError {
  if (turn == 1) throw ReceiveError({ message: "retry" });
  return true;
}

struct Endpoint {
  label: String;
  deinit { console.log(`released endpoint ${this.label}`); }
}

function check(shouldFail: boolean): void throws ReceiveError {
  if (shouldFail) throw ReceiveError({ message: "propagated" });
}

async function exitArm(mode: i32): i32 throws ReceiveError {
  const endpoint = Endpoint({ label: "outer" });
  await scheduler.yield();
  match (attempt receive(1)) {
    success(_) => return -1;
    failure(error) => {
      console.log(error.message);
      if (mode == 0) return 7;
      if (mode == 1) throw move error;
      try check(mode == 2);
    }
  }
  await scheduler.yield();
  return 8;
}

async function borrowAndDiscard(): i32 {
  const owned = Option.some(ReceiveError({ message: "borrowed" }));
  match (in owned) {
    some(value) => console.log(value.message);
    none => return -1;
  }
  await scheduler.yield();
  match (owned) {
    _ => {}
  }
  await scheduler.yield();
  return 0;
}

async function loopControl(): i32 {
  let turn = 0;
  while (turn < 3) {
    await scheduler.yield();
    turn = turn + 1;
    match (attempt receive(1)) {
      success(_) => return -1;
      failure(error) => {
        console.log(error.message);
        if (turn == 1) continue;
        break;
      }
    }
  }
  return turn - 2;
}

function nestedResult(): Option<ReceiveError> throws i32 {
  return Option.some(ReceiveError({ message: "nested" }));
}

async function nestedMatch(early: boolean): i32 {
  const result = attempt nestedResult();
  await scheduler.yield();
  match (result) {
    success(option) => {
      if (early) return 0;
      match (option) {
        some(value) => console.log(value.message);
        none => return 1;
      }
    }
    failure(_) => return 2;
  }
  await scheduler.yield();
  return 0;
}

async function listen(): i32 {
  let turn = 0;
  let accepted = 0;
  while (turn < 3) {
    match (attempt receive(turn)) {
      success(value) => { if (value) accepted = accepted + 1; }
      failure(error) => console.log(error.message);
    }
    await scheduler.yield();
    turn = turn + 1;
  }
  return accepted;
}

async function main(): i32 {
  const accepted = await listen();
  const returned = attempt await exitArm(0);
  match (returned) {
    success(value) => { if (value != 7) return 1; }
    failure(_) => return 2;
  }
  const thrown = attempt await exitArm(1);
  match (thrown) {
    success(_) => return 3;
    failure(error) => console.log(error.message);
  }
  const propagated = attempt await exitArm(2);
  match (propagated) {
    success(_) => return 4;
    failure(error) => console.log(error.message);
  }
  const fallthrough = attempt await exitArm(3);
  match (fallthrough) {
    success(value) => { if (value != 8) return 5; }
    failure(_) => return 6;
  }
  const borrowed = await borrowAndDiscard();
  const controlled = await loopControl();
  const nested = await nestedMatch(false);
  const early = await nestedMatch(true);
  await scheduler.yield();
  return accepted - 2 + borrowed + controlled + nested + early;
}
