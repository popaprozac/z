import console from "std/console";
import { AsyncGenerator } from "std/iteration";
import { delay } from "std/time";

class Label {
  id: i32;

  deinit {
    console.log(`released label ${this.id}`);
  }
}

struct Event {
  topic: Label;
  metadata: Label;
  value: i32;
}

function archiveTopic(topic: Label): void {}

async function events(): AsyncGenerator<Event> {
  yield Event({
    topic: new Label({ id: 1 }),
    metadata: new Label({ id: 101 }),
    value: 20,
  });
  yield Event({
    topic: new Label({ id: 2 }),
    metadata: new Label({ id: 102 }),
    value: 22,
  });
}

async function main(): i32 {
  let total = 0;
  for await (const { topic: selectedTopic, value } of events()) {
    await delay(1);
    console.log(`event ${selectedTopic.id} = ${value}`);
    total = total + value;
    if (value == 20) {
      archiveTopic(move selectedTopic);
      continue;
    }
  }
  return total - 42;
}
