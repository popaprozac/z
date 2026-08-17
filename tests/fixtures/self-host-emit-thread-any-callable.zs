import { thread } from "std/thread";

struct Message {
  value: i32;
}

type Handler = (in message: Message) => i32 on thread.any;
type LocalHandler = (in message: Message) => i32;

readonly class Offset {
  readonly value: i32;
}

function increment(in message: Message): i32 on thread.any {
  return message.value + 1;
}

function main(): i32 {
  const direct: Handler = increment;
  const offset = new Offset({ value: 20 });
  const captured: Handler = move (in message) => message.value + offset.value;
  const local: LocalHandler = captured;
  const first = Message({ value: 41 });
  const second = Message({ value: 22 });
  return direct(in first) + local(in second) - 84;
}
