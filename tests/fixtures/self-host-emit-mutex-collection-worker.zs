import { Map } from "std/collections";
import { Mutex } from "std/sync";
import { thread } from "std/thread";

readonly struct Message {
  arguments: readonly Array<String>;
  directory: Option<String>;
}

enum Request {
  message Message,
  empty,
}

struct State {
  pending: Map<usize, Request>;
  count: usize;
}

readonly class Inbox {
  private readonly state: Mutex<State>;

  constructor() {
    this.state = Mutex(State({ pending: Map<usize, Request>(), count: 0 }));
  }

  function admit(request: Request): boolean {
    return this.state.withLock(move (inout state): boolean => {
      if (state.count == 64) return false;
      state.pending.set(state.count, move request);
      state.count = state.count + 1;
      return true;
    });
  }
}

function produce(in inbox: Inbox): i32 {
  let accepted = 0;
  let index = 0;
  while (index < 100) {
    const arguments = Array<String>("launch");
    const message = Message({
      arguments: arguments.freeze(),
      directory: Option<String>.some("/tmp"),
    });
    if (inbox.admit(Request.message(move message))) accepted = accepted + 1;
    index = index + 1;
  }
  return accepted;
}

async function main(): i32 {
  const inbox = new Inbox();
  const first = thread.spawn(move (): i32 => produce(in inbox));
  const second = thread.spawn(move (): i32 => produce(in inbox));
  const third = thread.spawn(move (): i32 => produce(in inbox));
  const a = await first;
  const b = await second;
  const c = await third;
  return a + b + c - 64;
}
