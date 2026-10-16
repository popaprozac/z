import { Mutex } from "std/sync";
import console from "std/console";

struct Token {
  name: String;

  deinit {
    console.log(`released ${this.name}`);
  }
}

struct ReadError {
  message: String;
}

struct State {
  count: u32;
}

class Holder {
  readonly name: String;
  readonly state: Mutex<State>;
}

function find(handle: usize): Option<Holder> {
  if (handle == 0) return Option.none;
  return Option.some(new Holder({
    name: "holder",
    state: Mutex(State({ count: 0 })),
  }));
}

function verify(count: u32, fail: boolean): u32 throws ReadError {
  if (fail) throw ReadError({ message: "rejected" });
  return count;
}

// A returned arm value whose block callback owns locals and can exit early.
function counted(handle: usize, extra: usize): usize {
  const found = find(handle);
  return match (found) {
    some(holder) => holder.state.withLock((inout held): usize => {
      held.count = held.count + 1;
      const token = Token({ name: "returned" });
      if (extra == 0) return 0;
      let owned = Array<u8>();
      owned.push(1);
      return owned.length + extra;
    });
    none => 0;
  };
}

// A bound arm value whose callback also reads the arm's payload binding.
function named(handle: usize): usize {
  const found = find(handle);
  const length: usize = match (found) {
    some(holder) => holder.state.withLock((in held): usize => {
      const token = Token({ name: copy holder.name });
      return holder.name.byteLength + usize(held.count);
    });
    none => 0;
  };
  return length;
}

// A selecting block arm attempts a throwing callback with its own try.
function checked(handle: usize, fail: boolean): u32 throws ReadError {
  const found = find(handle);
  return match (found) {
    some(holder) => {
      const token = Token({ name: "arm" });
      select try holder.state.withLock((inout held): u32 throws ReadError => {
        const local = Token({ name: "attempt" });
        held.count = held.count + 2;
        const verified = try verify(held.count, fail);
        if (verified == 0) return 0;
        return verified + 1;
      });
    }
    none => 0;
  };
}

function apply(value: u32, in callback: (value: u32) => u32): u32 {
  return callback(value);
}

// A block closure that is an arm value takes the same completion path.
function picked(handle: usize, offset: u32): u32 {
  const found = find(handle);
  return match (found) {
    some(holder) => apply(u32(holder.name.byteLength), (value: u32): u32 => {
      const token = Token({ name: "closure" });
      if (offset == 0) return value;
      return value + offset;
    });
    none => 0;
  };
}

function main(): i32 {
  if (counted(1, 4) != 5) return 1;
  if (counted(1, 0) != 0) return 2;
  if (counted(0, 4) != 0) return 3;
  if (named(1) != 6) return 4;
  if (named(0) != 0) return 5;
  match (attempt checked(1, false)) {
    success(value) => if (value != 3) return 6;
    failure(_) => return 7;
  }
  match (attempt checked(1, true)) {
    success(_) => return 8;
    failure(error) => if (error.message != "rejected") return 9;
  }
  match (attempt checked(0, true)) {
    success(value) => if (value != 0) return 10;
    failure(_) => return 11;
  }
  if (picked(1, 2) != 8) return 12;
  if (picked(1, 0) != 6) return 13;
  if (picked(0, 2) != 0) return 14;
  console.log("done");
  return 0;
}
