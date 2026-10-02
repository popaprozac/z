import console from "std/console";
import { Channel } from "std/channel";
import { thread } from "std/thread";

// A block-bodied worker takes what it names from outside: a String, a
// scalar, and a channel endpoint. Its own locals stay its own, including
// one that shadows an outer Array.
async function main(): i32 {
  const label = "four";
  const base: u32 = 10;
  const { sender, receiver } = Channel<u32>.bounded(4);
  const syncSender = sender.sync();
  let items = Array<u32>();
  items.push(1);
  items.push(2);
  const worker = thread.spawn(move (): i32 => {
    let items = Array<u32>();
    items.push(base);
    items.push(u32(label.byteLength));
    let total: u32 = 0;
    for (const item of items) {
      total = total + item;
    }
    const outcome = attempt syncSender.send(total);
    return 0;
  });
  const syncReceiver = receiver.sync();
  const next = syncReceiver.receive();
  const joined = await worker;
  match (next) {
    some(value) => console.log(value + u32(items.length));
    none => return 1;
  }
  return 0;
}
