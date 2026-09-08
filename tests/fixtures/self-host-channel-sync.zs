import { Channel } from "std/channel";

function main(): i32 {
  const { sender, receiver } = Channel<i32>.bounded(1);
  const send = sender.sync();
  const receive = receiver.sync();
  const delivered = attempt send.send(42);
  return match (receive.receive()) {
    some(value) => value - 42;
    none => 1;
  };
}
