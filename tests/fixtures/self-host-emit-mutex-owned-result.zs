import { Mutex } from "std/sync";
import { replace } from "std/memory";
import console from "std/console";

struct Parcel {
  name: String;

  deinit {
    console.log(`released parcel ${this.name}`);
  }
}

struct ReadError {
  message: String;

  deinit {
    console.log(`released error ${this.message}`);
  }
}

class Snapshot {
  title: String;

  deinit {
    console.log(`released snapshot ${this.title}`);
  }
}

struct State {
  title: String;
  pending: Option<Parcel>;
  count: i32;
}

function title(in state: Mutex<State>): String {
  return state.withLock((in value): String => copy value.title);
}

function take(in state: Mutex<State>): Option<Parcel> {
  return state.withLock((inout value): Option<Parcel> => {
    const empty = Option<Parcel>.none;
    return replace(inout value.pending, move empty);
  });
}

function inspect(in state: Mutex<State>, fail: boolean): String throws ReadError {
  return try state.withLock((in value): String throws ReadError => {
    const temporary = Parcel({ name: "temporary" });
    if (fail) throw ReadError({ message: "unavailable" });
    return copy value.title;
  });
}

function plainCallbackInThrowingFunction(in state: Mutex<State>): String throws i32 {
  // This callback must not inherit the enclosing function's Result wrapper.
  return state.withLock((in value): String => { return copy value.title; });
}

function maybeRead(in text: String, fail: boolean): String throws ReadError {
  if (fail) throw ReadError({ message: copy text });
  return copy text;
}

function increment(inout state: State): void {
  state.count = state.count + 1;
}

function exercise(): i32 {
  const state = Mutex(State({
    title: "ready",
    pending: Option.some(Parcel({ name: "first" })),
    count: 0,
  }));
  const text = title(in state);
  if (text != "ready") return 1;
  const parcel = take(in state);
  match (parcel) {
    some(value) => {
      if (value.name != "first") return 2;
    }
    none => return 3;
  }
  match (take(in state)) {
    some(_) => return 4;
    none => {}
  }
  const snapshot = state.withLock((in value): Snapshot => {
    return new Snapshot({ title: copy value.title });
  });
  if (snapshot.title != "ready") return 5;
  match (attempt inspect(in state, true)) {
    success(_) => return 6;
    failure(error) => {
      if (error.message != "unavailable") return 7;
    }
  }
  // A typed failure must unlock before it reaches this caller.
  match (attempt inspect(in state, false)) {
    success(value) => {
      if (value != "ready") return 8;
    }
    failure(_) => return 9;
  }
  state.withLock((inout value): void => {
    value.pending = Option.some(Parcel({ name: "remaining" }));
  });
  match (attempt plainCallbackInThrowingFunction(in state)) {
    success(value) => { if (value != "ready") return 10; }
    failure(_) => return 11;
  }
  // A throwing expression callback can supply a success or forward a Result.
  const expression = attempt state.withLock(
    (in value): String throws ReadError => copy value.title
  );
  match (expression) {
    success(value) => { if (value != "ready") return 12; }
    failure(_) => return 13;
  }
  const forwarded = attempt state.withLock(
    (in value): String throws ReadError => try maybeRead(in value.title, true)
  );
  match (forwarded) {
    success(_) => return 14;
    failure(error) => { if (error.message != "ready") return 15; }
  }
  const localFailure = attempt state.withLock((in value): void throws ReadError => {
    throw ReadError({ message: copy value.title });
  });
  match (localFailure) {
    success => return 16;
    failure(error) => { if (error.message != "ready") return 17; }
  }
  const propagated = attempt state.withLock((in value): String throws ReadError => {
    const local = Parcel({ name: "propagated" });
    const text = try maybeRead(in value.title, true);
    return move text;
  });
  match (propagated) {
    success(_) => return 21;
    failure(error) => { if (error.message != "ready") return 22; }
  }
  const effect = attempt state.withLock(
    (inout value): void throws ReadError => increment(inout value)
  );
  match (effect) {
    success => {}
    failure(_) => return 18;
  }
  if (state.withLock((in value): i32 => value.count) != 1) return 19;
  const names = state.withLock((in value): Array<String> => {
    return Array<String>(copy value.title, "done");
  });
  if (names.length != 2 || names[0] != "ready" || names[1] != "done") return 20;
  // An ordinary Result-valued callback is not itself throwing.
  const explicitResult = state.withLock((in value): Result<String, ReadError> => {
    return attempt maybeRead(in value.title, false);
  });
  match (explicitResult) {
    success(value) => { if (value != "ready") return 23; }
    failure(_) => return 24;
  }
  return 0;
}

function main(): i32 {
  return exercise();
}
