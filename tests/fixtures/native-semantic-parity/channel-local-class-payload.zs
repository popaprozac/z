import console from "std/console";
import { Channel } from "std/channel";

// A message type that cannot cross threads still makes a channel used on one.
class Node {
  weight: u32;
}

function main(): i32 {
  const { sender, receiver } = Channel<Node>.bounded(4);
  const syncSender = sender.sync();
  const syncReceiver = receiver.sync();
  const outcome = attempt syncSender.send(new Node({ weight: 3 }));
  const next = syncReceiver.receive();
  match (next) {
    some(node) => console.log(node.weight);
    none => return 1;
  }
  return 0;
}
