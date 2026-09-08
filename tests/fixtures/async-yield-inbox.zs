import console from "std/console";
import { scheduler } from "std/async";
import { Mutex } from "std/sync";
import { Map } from "std/collections";

readonly struct Launch {
  arguments: readonly Array<String>;
  workingDirectory: Option<String>;
}

enum Request { launch Launch, }

function launch(in label: String): Request {
  const arguments = Array<String>(copy label);
  return Request.launch(Launch({ arguments: arguments.freeze(), workingDirectory: Option<String>.none }));
}

struct InboxState {
  pending: Map<usize, Request>;
  count: i32;
  deinit { console.log("released inbox"); }
}

function makeInbox(): Mutex<InboxState> {
  return Mutex(InboxState({ pending: Map<usize, Request>(), count: 0 }));
}

readonly class Inbox {
  private readonly state: Mutex<InboxState>;

  constructor() { this.state = makeInbox(); }

  function record(): void {
    this.state.withLock((inout state): void => {
      state.pending.set(0, launch("shared"));
      state.count = state.count + 1;
    });
  }

  function count(): i32 {
    return this.state.withLock((in state): i32 => state.count);
  }
}

async function deliverShared(inbox: Inbox): i32 {
  let delivered = 0;
  while (delivered < 2) {
    inbox.record();
    await scheduler.yield();
    delivered = delivered + 1;
  }
  return inbox.count();
}

async function deliver(inbox: Mutex<InboxState>, rounds: i32): i32 {
  let delivered = 0;
  while (delivered < rounds) {
    inbox.withLock((inout state): void => {
      state.pending.set(0, launch("launch"));
      state.count = state.count + 1;
    });
    await scheduler.yield();
    delivered = delivered + 1;
  }
  return inbox.withLock((in state): i32 => state.count);
}

async function main(): i32 {
  const inbox = new Inbox();
  const count = await deliverShared(inbox);
  return count + inbox.count() - 4;
}
