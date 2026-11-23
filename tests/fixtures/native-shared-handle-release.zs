import console from "std/console";
import { Channel, Sender } from "std/channel";
import { Mutex } from "std/sync";

// A shared handle passed on by value is retained for the callee and still
// owned by the caller: when the last holder lets go, what the handle guards
// is released, once.

struct Tracked {
  id: i32;
  deinit { console.log(`drop=${this.id}`); }
}

function peek(lock: Mutex<Tracked>): i32 {
  return lock.withLock((in value): i32 => value.id);
}

function push(sender: Sender<Tracked>, id: i32): boolean {
  const sync = sender.sync();
  const sent = attempt sync.send(Tracked({ id }));
  return match (sent) {
    success => true;
    failure(_) => false;
  };
}

function mutexCase(): i32 {
  const lock = Mutex(Tracked({ id: 1 }));
  const seen = peek(lock);
  console.log(`peeked ${seen}`);
  return seen;
}

function channelCase(): boolean {
  const { sender, receiver } = Channel<Tracked>.bounded(2);
  const first = push(sender, 2);
  const second = push(sender, 3);
  console.log(`sent ${first} ${second}`);
  return first && second;
}

function main(): i32 {
  const seen = mutexCase();
  console.log(`after mutex ${seen}`);
  const sent = channelCase();
  console.log(`after channel ${sent}`);
  return 0;
}
